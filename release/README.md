# 交付产物（release/）

本目录由 `pnpm package` 一条命令产出（构建 → 打包 → 校验和），**不要手工往里放文件**
（每次打包整目录重建）。当前版本 **0.1.0**。

| 文件 | 这是什么 | 怎么用 |
|---|---|---|
| `MDNaonao_0.1.0_x64_setup.exe` | **安装包**（NSIS，Windows x64） | 双击安装；自动注册 .md 文件关联，卸载走系统「应用列表」 |
| `MDNaonao_0.1.0_x64_portable.zip` | 便携版（F19，与安装版同一份 exe） | 解压即用，数据写在解压目录 `data\` 下，不碰注册表与 %APPDATA% |
| `SHA256SUMS.txt` | 两个交付物的校验和 | `certutil -hashfile <文件> SHA256` 比对，防下载损坏/被替换 |

> 重打包：`pnpm package`（完整构建）或 `pnpm package --no-build`（复用现有构建产物）。
> 换过应用图标必须先 `cargo clean -p mdnaonao --release`，否则 exe 里还是旧图标
> （见 src-tauri/icons/README.md）。
