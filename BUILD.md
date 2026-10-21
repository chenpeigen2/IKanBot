# 编译与打包指南（Windows）

> 把 IKanBot 从源码构建成可安装的 Windows 程序。

## 环境要求

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | **v24**（推荐 24.x） | 必须与 electron-builder 的预编译二进制兼容 |
| npm | 随 Node 自带 | 用于安装依赖 |
| 操作系统 | Windows 10 / 11 | 目标平台 |
| 磁盘 | ≥ 5 GB 空闲 | 打包会下载 Electron 并解压，临时占用大 |

> 环境曾在 Node 24 + 无 Visual Studio 编译工具 下验证通过。
> 项目用 **node-sqlite3-wasm（纯 WASM）**，不依赖 better-sqlite3，因此**不需要 C++ 编译工具链**。

## 一次性准备

```bash
cd D:/code/IKanBot
npm install
```

## 开发模式

```bash
npm run dev          # 热重载，改代码即时刷新
```

## 构建

```bash
npm run build        # 只产出 out/ 目录（不打包成 exe）
```

构建产物：
```
out/
  main/      主进程
  preload/   预加载脚本
  renderer/  渲染进程（前端）
```

## 打包成 Windows 安装包

```bash
npm run dist         # = npm run build && electron-builder
```

产物在 `release/`：

| 文件 | 说明 |
|---|---|
| `IKanBot-<版本>-x64.exe` | NSIS 安装包（可选安装目录、创建快捷方式） |
| `IKanBot-<版本>-portable.exe` | 免安装单文件版 |

> 两个都是 **x64** 架构，体积约 110 MB（含完整 Electron 运行时）。

### 只打免安装目录（不生成安装包，调试打包用）

```bash
npm run pack         # = electron-builder --dir
```

## 打包注意事项

### 1. 图标
- 应用图标在 `build/icon.ico`。
- 由 `scripts/after-pack.cjs` 在打包后调用 `rcedit-x64.exe` 写入。
- **如果报"图标设置失败"**：这是 Windows 文件句柄未释放的偶发问题，脚本已内置重试，
  多数情况重跑 `npm run dist` 即成功。

### 2. 数据库锁（`database is locked`）
- `node-sqlite3-wasm` 用"建一个 `<db>.lock` 目录"当排他锁。
- 若之前运行被强杀（`taskkill` / 超时），锁目录会残留，导致下次启动报 `database is locked`。
- **已在 `electron/db/index.ts` 的 `openDb()` 里做了自愈**：启动时检测到锁目录且确实是个目录就删掉。
- 如果你遇到这个错误，说明自愈没生效，手动删：
  ```bash
  rmdir data\ikanbot.db.lock
  ```

### 3. winCodeSign（签名工具）
- electron-builder 打包时需要解压 `winCodeSign`，其中含 macOS 符号链接，
  在**未开启开发者模式的非管理员环境**会失败。
- **绕过方案**：项目已配置 `scripts/after-pack.cjs` 直接用本地 `rcedit-x64.exe` 写图标，
  不依赖 electron-builder 内置的 winCodeSign 解压流程。

## 数据位置

打包版数据存放在（不是源码目录）：

```
%APPDATA%\IKanBot\data\
  ikanbot.db      SQLite 主库
  images/         商品图片与 Logo
  backups/        自动备份（zip，保留最近 30 份）
```

开发版数据在 `./data/`。

> 首次启动会自动建库并迁移到最新 schema（当前 `user_version = 7`）。

## 验证打包成功

```bash
# 首次启动打包版，应能自动建库
release/win-unpacked/IKanBot.exe
# 检查数据目录
dir "%APPDATA%\IKanBot\data"
```

## 常用命令速查

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发热重载 |
| `npm run build` | 构建到 out/ |
| `npm run pack` | 打包为免安装目录 |
| `npm run dist` | 打包为 NSIS 安装包 + 免安装 exe |
| `npm run test:e2e` | 端到端业务测试（395 项断言） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run seed` | 重建演示数据 |

## 版本号

`package.json` 里的 `version` 字段，会写进：
- 安装包文件名
- 应用内"关于"页
- exe 的文件属性（由 after-pack 写入）
