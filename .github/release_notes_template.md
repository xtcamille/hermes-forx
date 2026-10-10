### 📦 安装包下载 / Downloads
- **Windows (x64)**: `ForX-__VER__-win-x64.exe`
- **macOS (Apple Silicon M1/M2/M3/M4)**: `ForX-__VER__-mac-arm64.dmg` / `ForX-__VER__-mac-arm64.zip`

---

### 💡 安装与运行说明 / Installation Guide

#### 🪟 Windows 用户：
下载 `ForX-__VER__-win-x64.exe`，直接双击安装运行即可。已内嵌独立的 Python 3.11 及后端运行环境，无需自行安装配置 Python。

#### 🍎 macOS 用户（重要）：
下载 `ForX-__VER__-mac-arm64.dmg`，将 `ForX.app` 拖入 **应用程序** (Applications) 目录。

> ⚠️ **首次打开提示“文件已损坏，您应该将它移到废纸篓”或“无法打开”？**
> 这是因为本开源应用未配置苹果商业付费开发者证书（$99/年），被 macOS Gatekeeper 安全机制拦截，**并非安装包损坏**。
>
> **快速解决步骤（二选一）：**
> 1. **终端命令（推荐，最快）：** 打开 Mac 自带的「终端」(Terminal.app)，运行以下命令移除系统隔离标记：
>    ```bash
>    sudo xattr -cr /Applications/ForX.app
>    ```
>    输入开机密码回车后，再次双击 `ForX` 即可正常秒开！
> 2. **系统设置：** 双击打开提示已损坏后点击取消，打开 **「系统设置」->「隐私与安全性」**，滑到最底部安全性处，点击 **「仍要打开」** 并输入密码。

---
