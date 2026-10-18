# server-deck

在服务器上用 Claude Code 生成原生 `.pptx`，在浏览器里逐页审阅、点着形状写批注，再把批注交回同一个 Claude Code 会话去改。

*Review native .pptx decks built on a server in the browser, and hand the comments back to the Claude Code session that builds them. The UI is in Chinese.*

## 为什么做这个

Claude Code 跑在远程服务器上时，看一份 pptx 要先下载、打开，再把修改意见手打回终端，"右上角那块字太多"这种描述 agent 还经常找不到对应的元素。类似的工具（Claude Design、Open Design 等）把 HTML 当作品、pptx 只是导出物，审的和交付的不是同一个东西。

server-deck 审阅的就是交付的那份 pptx：

- 每页由 LibreOffice 渲染成图片；每个形状的位置从 pptx 的 XML 里读出来，叠在图上可点。
- 批注记下页码、形状名（pptxgenjs 的 `objectName`）和形状里的文字，agent 能直接对回生成脚本里的那一行。
- 批注只写在最新版上，先攒着，一键"复制为提示词"粘贴给 Claude（再复制时只带新写的）；也可以"发送"到服务器，agent 用 `deck comments` 读取、逐条标"已改 / 未改"并附一句说明。历史版本只能查看。
- 新版本发布后，有变化的页在缩略图上标蓝点，可以和上一版左右对照。
- 每页下面显示演讲者备注；可以下载每个版本的原 pptx。
- 发布前检查 deck 用到的字体服务器上是否都装了；缺一个就停下，因为字体被替换后换行和排版会和 PowerPoint 不一致。

### 视频

同一套流程也能审视频（mp4）：`deck publish x.mp4 talk` 之后，页面直接播放，在画面上拖一个框（或点一下）就暂停并在这一刻写批注，批注记下时间和框的范围。

- mp4 旁边如果有 `x.timeline.json`（也可用 `--timeline` 指定），左栏按场景列出缩略图和每句旁白，批注同时记下当时在播的场景、旁白 id 和旁白原文，agent 能直接对回旁白稿。格式见 `skill/SKILL.md` 的 Videos 一节；最好由合成视频的那一步写出，它知道每个场景多长。
- 新版本里画面、时长或旁白有变化的场景标蓝点。
- 提示词里给出视频和脚本路径；agent 用 `deck frame talk 03:12` 抽出那一帧的 PNG 来看，框选的批注加 `--box` 把框用红线画在图上。
- 播放支持拖动进度条（服务器按 HTTP Range 分段返回），也可以下载每个版本的原 mp4。

## 工作方式

```
Claude Code 生成 x.pptx
  → deck publish x.pptx talk        渲染每页 PNG、抽出形状框和备注，存为 data/talk/v<n>/
  → 浏览器打开 https://<你的域名>/deck/talk/，点形状写批注，复制为提示词
  → 粘贴给 Claude：改脚本 → 再 publish
    （或点"发送"，再说「看批注」：deck comments talk → 改脚本 → deck resolve → 再 publish）
```

渲染在 `deck` 命令行里完成；`server.mjs` 只提供静态文件和批注接口，只监听 `127.0.0.1`，需要放在带登录的反向代理后面。

## 依赖

- Node.js（在 24 上测试过）
- LibreOffice（`soffice`）、poppler（`pdftoppm`）、fontconfig（`fc-list`）
- 审视频还要 ffmpeg（`ffmpeg`、`ffprobe`）
- deck 用到的字体，装在 `~/.local/share/fonts/` 等 fontconfig 能找到的位置

Ubuntu：`sudo apt install libreoffice-impress poppler-utils fontconfig`

## 安装

```sh
git clone https://github.com/SipengXie2024/server-deck ~/server-deck
cd ~/server-deck && npm install
ln -s ~/server-deck/bin/deck.mjs ~/.local/bin/deck
echo '{ "urlBase": "https://example.com/deck/" }' > config.json   # deck publish 打印的网址前缀
```

- **服务**：按 `deploy/deck-server.service.example` 写一个 systemd 用户服务（默认端口 7240，可用 `DECK_PORT` 改）。
- **反向代理**：参考 `deploy/nginx.conf.example`。页面本身没有登录，一定要放在 auth 后面；代理传来的 `X-Remote-User` 会记为批注作者。
- **字体别名**：deck 里写的字体名和字体文件的家族名对不上时（例如 deck 要 `Foo Sans R`，字体文件叫 `Foo Sans`），照 `fonts/50-deck-aliases.conf.example` 写一份 `fonts/50-deck-aliases.conf`，并把它链接到 `~/.config/fontconfig/conf.d/`。
- **Claude Code skill**：把 `skill/SKILL.md` 复制到 `~/.claude/skills/deck-review/SKILL.md`，改掉里面的字体约定。它让 Claude 每次做完 pptx 自动发布、给形状命名，并在你说「看批注」时处理批注。

## 命令

```
deck publish <file.pptx> <name>          渲染并发布新版本，打印网址
deck publish <video.mp4> <name> [--timeline <t.json>]
                                         发布视频；默认读同目录的 <video>.timeline.json
deck frame <name> <时间> [--version <n>] [--box x,y,w,h]
                                         抽出视频某一时刻的画面，打印 PNG 路径；--box 把框画上去
deck comments <name> [--all]             打印最新版的待处理批注（--all 含已处理），作为提示词
deck resolve <name> <id> "<改了什么>"     标记已改
deck resolve <name> <id> --skip "<原因>"  标记不改
deck list                                列出所有 deck
```

数据目录默认是仓库下的 `data/`，可用 `DECK_DATA` 改。

## 限制

- 预览是 LibreOffice 的渲染结果，个别特效、图表细节和 PowerPoint 不完全一致；字体齐全时排版基本对得上。
- 形状框不处理旋转和翻转，按外接矩形算。
- 批注只能挂在幻灯片上的形状或整页上；对备注的意见写成整页批注。
- 视频没有"对照上一版"的左右同步播放，只标出有变化的场景；判定变化时每个场景只比 3 帧小图，只改了其他帧的画面可能漏标。
- 没有多人协作和权限区分，适合自己或小范围使用。

## 许可证

MIT
