// Package webui 以 embed.FS 内嵌全部前端资源，使 QxSSH 能编译为单文件可执行程序。
package webui

import "embed"

// FS 内嵌前端资源：启动页 index.html、桌面页 desktop.html、站点图标，
// 以及整棵 assets/（JS 核心库、CSS、字体、图标、内置语言包）与 apps/（内置应用）。
//
//go:embed index.html desktop.html favicon.ico assets apps
var FS embed.FS
