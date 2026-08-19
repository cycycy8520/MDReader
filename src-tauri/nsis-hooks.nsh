; ============================================================================
; MDNaonao —— NSIS 安装器钩子（DG 8「文件关联与右键」「安装/卸载生命周期」）
;
; 分工（红线 11：不自研已被官方覆盖的轮子）：
;   * 文件关联（.md/.markdown/.mdown/.mkd/.mkdn）由 tauri.conf.json 的
;     bundle.fileAssociations 交给 bundler 处理——注册、卸载时恢复旧值备份、
;     SHChangeNotify 刷新全部自动完成。**本文件一行都不要重复做关联。**
;   * 本文件只负责「额外右键动词」（转 HTML / 转 PDF / 导入 Obsidian / 分享）。
;
; 铁律（AI_DEV_GUIDE 红线 2/3、DG 10-2/10-7）：
;   1. 永不写入 / 删除 / 伪造 UserChoice 键（Windows 10+ 带哈希保护，应用不可写）；
;      设默认程序只能引导用户手动操作。
;   2. 写入范围仅限「自家 ProgID 下的键」+「额外右键动词」；
;      **永不整删 .md 等扩展名键**（那会破坏用户的其它关联）。
;   3. 安装期写入的每一个键，都必须在 PREUNINSTALL 钩子里逐一删除——
;      卸载残留是差评重灾区；新增键时必须同步补进下面的删除清单。
;   4. 任何注册表变更后调用 SHChangeNotify(SHCNE_ASSOCCHANGED) 刷新 Shell 缓存。
;   5. Win11 下 HKCU 动词进「显示更多选项」是设计行为，不是 bug（DG 10-6）；
;      一级菜单需 COM 组件 + 签名，属 V2 范围。
;
; 编码注意：本文件当前为 UTF-8 **无 BOM**——中文只出现在注释里，不影响编译。
; M2 写入带中文的菜单文案（如"转为 HTML"）时，必须把本文件另存为
; **UTF-8 with BOM**（NSIS 3 只有见到 BOM 才按 UTF-8 解析源文件），
; 否则安装后右键菜单会显示乱码。
; ============================================================================

; 自家 ProgID。2026-08-20 已核实回填（TODO 完成）：
; installer.nsi 的 APP_ASSOCIATE 第二参即 ProgID = fileAssociations 的 name 字段
; （"Markdown"），装机注册表 HKCU\Software\Classes\Markdown\shell\open\command
; 指向本应用亦为佐证。额外动词与 DefaultIcon 都必须挂在它下面。
!define MDV_PROGID "Markdown"

; 动词注册的根位置。installMode = currentUser，因此写 HKCU\Software\Classes。
; TODO(M2)：若将来改为 perMachine / both，需按 $MultiUser.InstallMode 分支切到 HKLM。
!define MDV_CLASSES_ROOT "Software\Classes"

; SHCNE_ASSOCCHANGED = 0x08000000，SHCNF_IDLIST = 0
!macro MDVRefreshShell
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; ----------------------------------------------------------------------------
; 安装前：当前无需处理（关联备份由 bundler 自己做）
; ----------------------------------------------------------------------------
!macro NSIS_HOOK_PREINSTALL
!macroend

; ----------------------------------------------------------------------------
; 安装后：写入额外右键动词
;
; TODO(M2 / M3)：按 DG 3.1 FR-07/FR-08/FR-09/FR-10 落地下列动词，
; 每个动词的命令行都走 `--action`（cmdline.rs 解析，无 UI 路径必须写日志，DG 10-8）：
;   to-html         "转为 HTML"        v1.0(M2)
;   to-pdf          "转为 PDF"         v1.0(M2)
;   import-obsidian "导入 Obsidian"    v1.1(M3)
;   share-image     "生成长图"          v1.1(M3)
;
; 参考写法（确认 ProgID 后启用）：
;   WriteRegStr HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\shell\MDNaonao.ToHtml" "" "转为 HTML"
;   WriteRegStr HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\shell\MDNaonao.ToHtml" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
;   WriteRegStr HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\shell\MDNaonao.ToHtml\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --action to-html "%1"'
; ----------------------------------------------------------------------------
!macro NSIS_HOOK_POSTINSTALL
  ; .md 文件图标（2026-08-20 用户指定：文件图标与应用图标分离）：
  ; bundler 的 APP_ASSOCIATE 把 DefaultIcon 写成 "$INSTDIR\exe,0"（= 应用图标），
  ; 本钩子跑在其后，用附带的专用 ico 覆盖同一键——只动自家 ProgID（铁律 2），
  ; 卸载时 PREUNINSTALL 显式删除 + bundler 的 APP_UNASSOCIATE 整体移除双保险。
  ; ico 由 bundle.resources 落到 $INSTDIR\icons\md-file.ico。
  WriteRegStr HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\DefaultIcon" "" '"$INSTDIR\icons\md-file.ico",0'
  ; TODO(M2)：在此写入上述额外动词键。
  !insertmacro MDVRefreshShell
!macroend

; ----------------------------------------------------------------------------
; 卸载前：逐一删除安装期/运行期写入的全部自家键
;
; 只删自己写的动词子键，**不动 ProgID 之外的任何东西**，更不碰 .md 扩展名键
; 与 UserChoice；bundler 负责把关联恢复成安装前的备份值。
; 删除清单必须与 POSTINSTALL 的写入清单一一对应。
; ----------------------------------------------------------------------------
!macro NSIS_HOOK_PREUNINSTALL
  ; 与 POSTINSTALL 一一对应（铁律 3）：删掉自己写的 DefaultIcon 覆盖。
  ; bundler 的 APP_UNASSOCIATE 随后会整体移除 ProgID，这里是显式对账不是依赖它。
  DeleteRegKey HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\DefaultIcon"
  ; TODO(M2)：与 POSTINSTALL 一一对应地删除额外动词，例如：
  ;   DeleteRegKey HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\shell\MDNaonao.ToHtml"
  ;   DeleteRegKey HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\shell\MDNaonao.ToPdf"
  ;   DeleteRegKey HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\shell\MDNaonao.ImportObsidian"
  ;   DeleteRegKey HKCU "${MDV_CLASSES_ROOT}\${MDV_PROGID}\shell\MDNaonao.ShareImage"
  !insertmacro MDVRefreshShell
!macroend

; ----------------------------------------------------------------------------
; 卸载后：询问是否删除用户数据目录
;
; TODO(M2)：按 DG 8「安装/卸载生命周期」增加询问——
;   MessageBox 说明 %APPDATA%\MDNaonao\ 内含最近列表、设置与**飞书密钥**，
;   用户确认后 RMDir /r "$APPDATA\MDNaonao"；默认不删。
; 静默卸载（/S）时一律不删用户数据。
; ----------------------------------------------------------------------------
!macro NSIS_HOOK_POSTUNINSTALL
!macroend
