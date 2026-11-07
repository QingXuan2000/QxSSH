#!/usr/bin/env python3
"""QxSSH UDP 中继（远端侧代理）。

由 QxSSH 上传到远端临时目录并执行。它把 SSH 会话里的 TCP 通道与远端 UDP 服务
对接：通道上传输的是定长头帧，每一帧恰好是一个 UDP 数据报。两种模式：

固定目标（默认，-L 风格的 UDP 转发）

    +--------+--------+--------------------+
    | len hi | len lo | payload (len 字节) |
    +--------+--------+--------------------+

    每条 TCP 连接对应一个独立的上游 UDP socket，因此同一台远端服务看到的源端口
    互不相同，回包也能按连接准确路由回各自的客户端。

随意目标（--any，SOCKS5 UDP ASSOCIATE）

    +--------+--------+------+----------+--------+------+-------------+
    | len hi | len lo | atyp |   addr   | port   | ...  | payload     |
    +--------+--------+------+----------+--------+------+-------------+

    atyp/addr/port 与 SOCKS5 的 ATYP|ADDR|PORT 完全一致（1=IPv4，3=域名，
    4=IPv6），len 覆盖 atyp 到 payload 的全部字节。一条连接可以发往任意目的
    地址，回包的地址头填的是应答方的真实地址。

用法：
    python3 qxssh-udp-xxxx.py --host 127.0.0.1 --port 0 --target 10.0.0.5:53
    python3 qxssh-udp-xxxx.py --host 127.0.0.1 --port 0 --any

启动成功后在标准输出打印 QXPORT=<实际监听端口>，随后进入服务循环。
"""

import argparse
import select
import socket
import struct
import sys
import threading
import time

MAX_DGRAM = 65535
UP_TIMEOUT = 1.0


def read_exact(conn, n):
    """从 TCP 通道精确读取 n 字节；对端关闭时返回 None。"""
    buf = bytearray()
    while len(buf) < n:
        try:
            chunk = conn.recv(n - len(buf))
        except OSError:
            return None
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def decode_addr(buf, off):
    """从 ATYP|ADDR|PORT 解出 (host, port, 新偏移)。"""
    if off >= len(buf):
        raise ValueError("帧太短")
    atyp = buf[off]
    off += 1
    if atyp == 1:
        if len(buf) < off + 6:
            raise ValueError("IPv4 地址不完整")
        host = socket.inet_ntop(socket.AF_INET, buf[off:off + 4])
        off += 4
    elif atyp == 4:
        if len(buf) < off + 18:
            raise ValueError("IPv6 地址不完整")
        host = socket.inet_ntop(socket.AF_INET6, buf[off:off + 16])
        off += 16
    elif atyp == 3:
        if len(buf) < off + 1:
            raise ValueError("域名长度缺失")
        n = buf[off]
        off += 1
        if n == 0 or len(buf) < off + n + 2:
            raise ValueError("域名不完整")
        host = buf[off:off + n].decode("utf-8", "replace")
        off += n
    else:
        raise ValueError("不认识的地址类型 %d" % atyp)
    (port,) = struct.unpack("!H", buf[off:off + 2])
    off += 2
    return host, port, off


def encode_addr(host, port):
    """把 (host, port) 编成 ATYP|ADDR|PORT。"""
    try:
        return b"\x01" + socket.inet_pton(socket.AF_INET, host) + struct.pack("!H", port)
    except OSError:
        pass
    try:
        return b"\x04" + socket.inet_pton(socket.AF_INET6, host) + struct.pack("!H", port)
    except OSError:
        pass
    raw = host.encode("utf-8")[:255]
    return b"\x03" + bytes([len(raw)]) + raw + struct.pack("!H", port)


class Channel(object):
    """一条 TCP 通道 <-> 一个目标 UDP socket 的桥（固定目标模式）。"""

    def __init__(self, conn, family, sockaddr):
        self.conn = conn
        self.up = socket.socket(family, socket.SOCK_DGRAM)
        self.up.connect(sockaddr)
        self.up.settimeout(UP_TIMEOUT)
        self.wlock = threading.Lock()
        self.stop = threading.Event()

    def pump_down(self):
        """上游 UDP -> 通道：把目标返回的报文按帧写回客户端。"""
        while not self.stop.is_set():
            try:
                data = self.up.recv(MAX_DGRAM)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                continue
            frame = struct.pack("!H", len(data)) + data
            try:
                with self.wlock:
                    self.conn.sendall(frame)
            except OSError:
                break
        self.stop.set()

    def run(self):
        down = threading.Thread(target=self.pump_down, daemon=True)
        down.start()
        try:
            while not self.stop.is_set():
                head = read_exact(self.conn, 2)
                if head is None:
                    break
                (size,) = struct.unpack("!H", head)
                if size == 0:
                    continue
                payload = read_exact(self.conn, size)
                if payload is None:
                    break
                try:
                    self.up.send(payload)
                except OSError:
                    break
        finally:
            self.stop.set()
            for sock in (self.conn, self.up):
                try:
                    sock.close()
                except OSError:
                    pass
            down.join(timeout=2.0)


class AnyChannel(object):
    """一条 TCP 通道 <-> 任意目标的桥（--any 模式，服务 SOCKS5 UDP ASSOCIATE）。"""

    def __init__(self, conn):
        self.conn = conn
        self.socks = {}
        self.routes = {}
        self.lock = threading.Lock()
        self.wlock = threading.Lock()
        self.stop = threading.Event()

    def _sock(self, family):
        with self.lock:
            s = self.socks.get(family)
            if s is None:
                s = socket.socket(family, socket.SOCK_DGRAM)
                s.settimeout(UP_TIMEOUT)
                self.socks[family] = s
            return s

    def _route(self, host, port):
        """解析目的地并缓存，避免每个数据报都做一次 getaddrinfo。"""
        key = (host, port)
        with self.lock:
            hit = self.routes.get(key)
        if hit is not None:
            return hit
        infos = socket.getaddrinfo(host, port, 0, socket.SOCK_DGRAM)
        if not infos:
            raise OSError("目标没有可用地址")
        family, _, _, _, sockaddr = infos[0]
        with self.lock:
            if len(self.routes) > 1024:
                self.routes.clear()
            self.routes[key] = (family, sockaddr)
        return family, sockaddr

    def pump_down(self):
        """任意上游 UDP -> 通道：回包带上应答方地址。"""
        while not self.stop.is_set():
            with self.lock:
                socks = list(self.socks.values())
            if not socks:
                time.sleep(0.05)
                continue
            try:
                ready, _, _ = select.select(socks, [], [], UP_TIMEOUT)
            except (OSError, ValueError):
                break
            for s in ready:
                try:
                    data, src = s.recvfrom(MAX_DGRAM)
                except OSError:
                    continue
                if not data:
                    continue
                body = encode_addr(src[0], src[1]) + data
                if len(body) > MAX_DGRAM:
                    continue
                try:
                    with self.wlock:
                        self.conn.sendall(struct.pack("!H", len(body)) + body)
                except OSError:
                    self.stop.set()
                    return
        self.stop.set()

    def run(self):
        down = threading.Thread(target=self.pump_down, daemon=True)
        down.start()
        try:
            while not self.stop.is_set():
                head = read_exact(self.conn, 2)
                if head is None:
                    break
                (size,) = struct.unpack("!H", head)
                if size == 0:
                    continue
                body = read_exact(self.conn, size)
                if body is None:
                    break
                try:
                    host, port, off = decode_addr(body, 0)
                except (ValueError, OSError):
                    continue
                payload = body[off:]
                if not payload:
                    continue
                try:
                    family, sockaddr = self._route(host, port)
                    self._sock(family).sendto(payload, sockaddr)
                except OSError:
                    continue
        finally:
            self.stop.set()
            with self.lock:
                socks = list(self.socks.values())
                self.socks = {}
            for s in socks:
                try:
                    s.close()
                except OSError:
                    pass
            try:
                self.conn.close()
            except OSError:
                pass
            down.join(timeout=2.0)


def split_target(target):
    if ":" not in target:
        raise ValueError("target 必须是 host:port")
    host, port = target.rsplit(":", 1)
    host = host.strip().strip("[]")
    if not host:
        raise ValueError("target 缺少主机名")
    port = int(port)
    if port < 1 or port > 65535:
        raise ValueError("target 端口越界")
    return host, port


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--target", default="")
    ap.add_argument("--any", action="store_true")
    args = ap.parse_args()

    family = socket.AF_INET
    sockaddr = None
    if not args.any:
        if not args.target:
            sys.stderr.write("固定目标模式需要 --target，或改用 --any\n")
            return 2
        try:
            host, port = split_target(args.target)
        except ValueError as exc:
            sys.stderr.write("%s\n" % exc)
            return 2
        try:
            infos = socket.getaddrinfo(host, port, 0, socket.SOCK_DGRAM)
        except OSError as exc:
            sys.stderr.write("目标解析失败：%s\n" % exc)
            return 2
        if not infos:
            sys.stderr.write("目标解析失败：没有可用地址\n")
            return 2
        family, _, _, _, sockaddr = infos[0]

    bind_family = socket.AF_INET6 if ":" in args.host else socket.AF_INET
    srv = socket.socket(bind_family, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((args.host, args.port))
        srv.listen(64)
    except OSError as exc:
        sys.stderr.write("监听失败：%s\n" % exc)
        return 2

    sys.stdout.write("QXPORT=%d\n" % srv.getsockname()[1])
    sys.stdout.flush()

    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            return 0
        try:
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        if args.any:
            worker = AnyChannel(conn)
        else:
            worker = Channel(conn, family, sockaddr)
        threading.Thread(target=worker.run, daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
