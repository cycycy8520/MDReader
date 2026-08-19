//! DG 7.1 `share/lark.rs` 职责：token 缓存刷新、`medias/upload_all` + `import_tasks`、降级逻辑。
//!
//! 链路（事实库 #7，已联网核验，**不要重新调研、不要"好心纠正"**）：
//! 1. `POST /open-apis/drive/v1/medias/upload_all`（`parent_type=ccm_import_open`）→ 拿 `file_token`；
//! 2. `POST /open-apis/drive/v1/import_tasks`（**复数**，不是 `import_task`）→ 拿 `ticket`；
//! 3. 轮询 `GET /open-apis/drive/v1/import_tasks/:ticket` → 成功后拿云文档 url 并打开。
//!
//! 硬性细节：
//! * MD 上限 **20MB**，超限直接提示不支持 API 导入并降级默认通道（复制富文本）；
//! * `file_extension` 必须与实际后缀**严格一致**，否则报错码 **1069910**；
//! * 最小权限集只申请两个：`docs:document:import` + `docs:document.media:upload`；
//! * 个人版账号须先免费建团队才能创建自建应用（配置引导四步的第一步）；
//! * 任一步失败 → 降级默认通道（DG 7.2-6），不得让用户卡在错误里。
//!
//! ## 两条纪律，改这个文件之前先读
//!
//! **① 凭据与 token 绝不出现在日志里。** app_secret 与 tenant_access_token 一旦进了
//! `logs\`，就等于跟着用户的「打包日志求助」发到了公开渠道。本模块里所有涉及凭据的
//! `tracing` 调用只记「有没有 / 什么时候过期 / 打码后的 app_id」，
//! 明文一律经 [`crate::settings`] 的 DPAPI 通道进出，不落地第二份。
//!
//! **② 这条通道是「进阶」，不是主路径。** 零配置的默认通道（复制富文本 → 粘进飞书文档）
//! 永远可用且永远是默认（DG 9.3 风险 #3）。因此本模块的每一个失败都必须是**可降级**的：
//! 一律返回 `Err`，由前端 catch 后自动退回默认通道并 toast 说明，
//! 绝不设计成「配置了 API 就只能走 API」。
//!
//! ## 为什么没有 dingtalk.rs（钉钉，事实库 #8）
//!
//! **钉钉没有公开的文档导入 API**（2026-08 核验，DG 2.3-4）：官方 API 列表里不存在
//! 「上传 .md 生成在线文档」这种接口，「创建知识库文档」只能建空框架，且第三方个人应用
//! 不支持。所以钉钉这一栏的正确形态就是如实降级 —— 复制富文本（面向钉钉文档编辑器）/
//! 复制长图 / 发送文件三条兜底，UI 上写清「钉钉未开放文档导入接口」。
//!
//! **不要去找、不要硬编码任何未公开接口**：内部接口没有兼容性承诺，改一次就全线报错，
//! 而且会把用户的企业账号置于风险里。这个结论已经核验过一次，
//! 写在这里就是为了免得后来者再调研一遍（DG 2.2 也已把「钉钉 API 通道」列入范围外）。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::settings::{self, LarkCredential};

/// 飞书开放平台域名。
pub const LARK_BASE_URL: &str = "https://open.feishu.cn";

/// 上传接口的 parent_type（导入场景固定值）。
pub const PARENT_TYPE_IMPORT: &str = "ccm_import_open";

/// API 导入的文件大小上限（20MB）。
pub const MAX_IMPORT_BYTES: u64 = 20 * 1024 * 1024;

/// `file_extension` 与实际后缀不一致时的错误码。
pub const ERR_EXTENSION_MISMATCH: i64 = 1069910;

/// 轮询间隔与上限（轮询是异步任务，飞书侧转换需要时间）。
pub const POLL_INTERVAL_MS: u64 = 1000;
pub const POLL_MAX_ATTEMPTS: u32 = 60;

// ---------------------------------------------------------------------------
// 端点与固定参数
// ---------------------------------------------------------------------------

/// 换 tenant_access_token（自建应用）。
///
/// 这个端点的返回体是**平的**：`tenant_access_token` 与 `expire` 直接挂在顶层，
/// 不在 `data` 里 —— 与开放平台其余接口不一样，别照着 [`LarkEnvelope`] 去解。
const PATH_TENANT_TOKEN: &str = "/open-apis/auth/v3/tenant_access_token/internal";

/// 素材上传（multipart）。
const PATH_UPLOAD_ALL: &str = "/open-apis/drive/v1/medias/upload_all";

/// 创建导入任务 / 查询导入任务（**复数** import_tasks，事实库 #7）。
const PATH_IMPORT_TASKS: &str = "/open-apis/drive/v1/import_tasks";

/// 导入目标文档类型：`docx` = 新版飞书文档。
///
/// 不做成可配置项：本产品导入的永远是 Markdown，而 Markdown 在飞书侧只有
/// 「新版文档」这一个合理落点（sheet/bitable 是给表格类源文件的）。
const IMPORT_TARGET_TYPE: &str = "docx";

/// 挂载类型 1 = 云空间。飞书目前也只定义了这一种。
const MOUNT_TYPE_CLOUD_SPACE: i64 = 1;

/// 挂载点 token。空字符串 = 挂到「我的空间」根目录（DG 7.2-6）。
///
/// 留成常量而不是入参：V1 不做「选择飞书目录」的 UI（那需要再调一套文件夹列举接口，
/// 与「小而美」不成比例）。将来要做，把它提成 [`create_import_task`] 的参数即可。
const MOUNT_KEY_ROOT: &str = "";

/// token 提前刷新的余量（秒）。
///
/// 飞书给的 `expire` 通常是 7200s。提前 5 分钟判定过期是为了避开「取 token 时还剩 3 秒、
/// 等上传 20MB 传完就已经失效」这类边界 —— 上传本身可能跑几十秒。
const TOKEN_REFRESH_MARGIN_SECS: i64 = 300;

/// 常规请求超时（换 token、建任务、轮询）。
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// 上传素材超时。给到 5 分钟：20MB 在家庭上行带宽下几十秒到几分钟都属正常，
/// 用 30s 掐掉等于「大文件永远导不进去」。
const UPLOAD_TIMEOUT_SECS: u64 = 300;

/// 错误信息里回显响应体的字符数上限。
///
/// 必须截断：出错时对端可能返回一整页 HTML（网关/代理拦截），
/// 整段塞进 `AppError` 会灌满日志文件，还可能把 Cookie 之类的东西一起带进去。
const BODY_PREVIEW_CHARS: usize = 200;

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

/// 导入任务状态机。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportState {
    Uploading,
    Importing,
    Succeeded,
    Failed,
}

/// 导入结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub state: ImportState,
    /// 成功后的云文档链接
    pub url: Option<String>,
    /// 失败原因（面向日志；用户文案由前端 i18n 决定）
    pub message: Option<String>,
}

/// tenant_access_token 缓存（落盘时经 DPAPI 加密，见 [`crate::settings`]）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCache {
    pub token: String,
    /// 过期时间戳（秒）。提前 5 分钟视为过期以避开边界。
    pub expires_at: i64,
}

impl TokenCache {
    /// 是否仍可用（已扣掉 [`TOKEN_REFRESH_MARGIN_SECS`] 的余量）。
    fn is_fresh(&self, now: i64) -> bool {
        !self.token.is_empty() && self.expires_at - TOKEN_REFRESH_MARGIN_SECS > now
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 进阶通道：把当前 .md 导入飞书云文档并返回链接（FR-11）。
///
/// 失败一律返回 `Err` —— 前端据此**自动降级**默认通道（复制富文本 + 提示粘贴），
/// 这是 DG 7.2-6 与 DG 6.6「分享失败」那一行的契约，不要改成静默成功。
#[tauri::command]
pub async fn import_to_lark(path: PathBuf) -> AppResult<ImportResult> {
    let started = std::time::Instant::now();

    let metadata = std::fs::metadata(&path)
        .map_err(|err| AppError::not_found(format!("{}（{err}）", path.display())))?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    precheck(metadata.len(), extension)?;
    // precheck 已保证归一化成功，这里不会走到 unwrap_or
    let extension = normalized_extension(extension).unwrap_or("md");

    tracing::info!(
        source = %path.display(),
        bytes = metadata.len(),
        extension,
        "飞书导入：开始"
    );

    let token = fetch_tenant_access_token().await?;
    let file_token = upload_media(&token.token, &path).await?;
    let ticket = create_import_task(&token.token, &file_token, extension).await?;
    let result = poll_import_task(&token.token, &ticket).await?;

    if result.state != ImportState::Succeeded {
        return Err(AppError::api(
            result
                .message
                .unwrap_or_else(|| "飞书导入任务失败（未给出原因）".to_string()),
        ));
    }
    let Some(url) = result.url.clone() else {
        return Err(AppError::api(
            "飞书导入任务报告成功但没有返回文档链接，无法定位产物".to_string(),
        ));
    };

    tracing::info!(
        %url,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "飞书导入：完成"
    );
    Ok(result)
}

/// 设置页「测试连接」：用 app_id/secret 换一次 tenant_access_token 即可验证。
///
/// 刻意**绕开缓存**：缓存里那个 token 是上一副凭据换来的，用它去测只会得到
/// 「连接正常」的假象。同时也不会顺带发起导入 —— 测试就该只测一件事。
///
/// 无入参（沿用既有签名）意味着它测的是**已保存的**凭据，
/// 所以设置页的顺序必须是「先保存、再测试」。
#[tauri::command]
pub async fn test_lark_connection() -> AppResult<()> {
    let credential = require_credential()?;
    let cache = request_tenant_access_token(&credential).await?;
    // 测试成功顺手把 token 存进缓存：紧接着的第一次导入就不用再换一次
    if let Err(err) = settings::store_lark_token(&cache.token, cache.expires_at) {
        // 缓存写不进去不影响「连接是通的」这个结论，降级为 warn
        tracing::warn!(%err, "飞书 token 缓存写入失败（不影响本次连接测试结论）");
    }
    tracing::info!("飞书连接测试通过");
    Ok(())
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/// 当前 Unix 秒。系统时钟被调到 1970 之前时回 0（那种机器上 token 每次都会重取，
/// 比 panic 或者算出一个负数当成「永不过期」要好）。
fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 取已保存的凭据；没配过就给一句能照着做的错误。
fn require_credential() -> AppResult<LarkCredential> {
    settings::load_lark_credential_sync()?.ok_or_else(|| {
        AppError::config(
            "尚未配置飞书自建应用凭据（需依次完成：创建团队 → 创建企业自建应用 → \
             开通 docs:document:import 与 docs:document.media:upload 并发布版本 → 填入 app_id/app_secret）"
                .to_string(),
        )
    })
}

/// 建一个带超时的 HTTP 客户端。
///
/// 每次调用现建而不是全局复用：分享是低频动作（一次导入总共 3 类请求），
/// 常驻一个连接池换来的收益远不及「凭据/代理配置改了立刻生效」来得实在。
fn http_client(timeout_secs: u64) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(AppError::from)
}

fn endpoint(path: &str) -> String {
    format!("{LARK_BASE_URL}{path}")
}

/// 截断响应体，只留开头一小段进错误信息（理由见 [`BODY_PREVIEW_CHARS`]）。
///
/// **只能用在不会回传凭据的端点上**（上传 / 建任务 / 轮询——它们的返回体里是
/// file_token、ticket、文档链接，token 走的是 Authorization 头、不会被回显）。
/// 换 token 那个端点的 body 里装着 tenant_access_token 本身，
/// 见 [`request_tenant_access_token`] 里的说明，那里刻意没有调用本函数。
fn body_preview(body: &str) -> String {
    let preview: String = body.chars().take(BODY_PREVIEW_CHARS).collect();
    if body.chars().count() > BODY_PREVIEW_CHARS {
        format!("{preview}…")
    } else {
        preview
    }
}

/// 开放平台通用返回信封：`{ code, msg, data }`。
///
/// `code` 不给 `default`：缺了它说明这压根不是飞书的返回体（网关拦截页、代理错误页），
/// 那时应当解析失败并把 body 前若干字符回显出来，而不是当成 `code = 0` 的成功。
///
/// `data` 上**不要**加 `#[serde(default)]`：serde 的 derive 一旦在含泛型参数的字段上
/// 看到该属性，就会给整个 `Deserialize` impl 追加 `T: Default` 约束，
/// 于是每个返回体类型都得白白实现 Default（实测编译错误 E0277）。
/// 而 `Option<T>` 字段在 serde 里本来就允许缺省 → 缺字段自动为 `None`，
/// 加不加行为完全一致，加了纯粹是自找约束。
#[derive(Debug, Deserialize)]
struct LarkEnvelope<T> {
    code: i64,
    #[serde(default)]
    msg: String,
    data: Option<T>,
}

/// 把「HTTP 响应 → 校验 code → 取 data」这条固定动作收成一处。
async fn read_envelope<T: serde::de::DeserializeOwned>(
    step: &str,
    response: reqwest::Response,
) -> AppResult<T> {
    let status = response.status();
    let body = response.text().await?;

    let envelope: LarkEnvelope<T> = serde_json::from_str(&body).map_err(|err| {
        AppError::api(format!(
            "飞书{step}返回体无法解析（HTTP {status}，{err}）：{}",
            body_preview(&body)
        ))
    })?;

    if envelope.code != 0 {
        return Err(AppError::api(explain_lark_error(
            step,
            envelope.code,
            &envelope.msg,
        )));
    }
    envelope.data.ok_or_else(|| {
        AppError::api(format!(
            "飞书{step}返回 code=0 但缺少 data：{}",
            body_preview(&body)
        ))
    })
}

/// 把飞书的业务错误码翻成「知道下一步该干什么」的话。
///
/// **只特判 [`ERR_EXTENSION_MISMATCH`] 一个码** —— 它是事实库 #7 明确核验过的。
/// 其余一律原样透出 `code` + `msg`，再附一句与具体码无关的通用排查方向。
///
/// 为什么不多枚举几个码：开放平台的错误码表会随平台演进，凭印象抄一份进代码，
/// 换来的是「我们的解释」和「实际原因」对不上——那比不解释更耽误人。
/// 飞书自己的 `msg` 才是第一手信息，我们的职责是把它**原样**带到用户面前。
fn explain_lark_error(step: &str, code: i64, msg: &str) -> String {
    if code == ERR_EXTENSION_MISMATCH {
        return format!(
            "飞书{step}失败：code={code} msg={msg}\
             （file_extension 必须与上传时的文件名后缀严格一致，事实库 #7）"
        );
    }
    format!(
        "飞书{step}失败：code={code} msg={msg}\
         （若持续失败，请依次核对：应用是否已开通 docs:document:import 与 \
         docs:document.media:upload 两项权限；改完权限后是否**发布了新版本**——未发布不生效）"
    )
}

/// 换 tenant_access_token 的返回体（**平结构**，见 [`PATH_TENANT_TOKEN`] 的注释）。
#[derive(Debug, Deserialize)]
struct TenantTokenResponse {
    code: i64,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    tenant_access_token: Option<String>,
    /// 有效期（秒）
    #[serde(default)]
    expire: Option<i64>,
}

/// 获取 / 刷新 tenant_access_token（带缓存，过期前 5 分钟刷新）。
pub async fn fetch_tenant_access_token() -> AppResult<TokenCache> {
    let credential = require_credential()?;

    if let (Some(token), Some(expires_at)) =
        (&credential.tenant_access_token, credential.expires_at)
    {
        let cache = TokenCache {
            token: token.clone(),
            expires_at,
        };
        if cache.is_fresh(now_unix()) {
            tracing::debug!(expires_at, "飞书 token：命中缓存");
            return Ok(cache);
        }
    }

    let cache = request_tenant_access_token(&credential).await?;
    if let Err(err) = settings::store_lark_token(&cache.token, cache.expires_at) {
        // 存不下只是下次还要再换一次，不该让本次导入失败
        tracing::warn!(%err, "飞书 token 缓存写入失败（本次导入继续）");
    }
    Ok(cache)
}

/// 真的去换一次 token（无缓存）。
async fn request_tenant_access_token(credential: &LarkCredential) -> AppResult<TokenCache> {
    let response = http_client(REQUEST_TIMEOUT_SECS)?
        .post(endpoint(PATH_TENANT_TOKEN))
        .json(&serde_json::json!({
            "app_id": credential.app_id,
            "app_secret": credential.app_secret,
        }))
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;
    // 这里**故意不回显 body**（与 read_envelope 的处理不同）：这个端点的成功返回体里
    // 就装着 tenant_access_token 本身，而「解析失败」并不保证 body 里没有 token
    // （比如 code 字段变成了字符串，token 却照常在）。一旦回显，token 就进了
    // AppError → 日志文件 → 用户打包日志求助时发到公开渠道。
    // serde_json 的错误只给「第几行第几列期望什么」，不含内容，可以安全带上。
    let parsed: TenantTokenResponse = serde_json::from_str(&body).map_err(|err| {
        AppError::api(format!(
            "飞书换取 token 的返回体无法解析（HTTP {status}，{err}，共 {} 字节）",
            body.len()
        ))
    })?;

    if parsed.code != 0 {
        return Err(AppError::api(explain_lark_error(
            "换取 token",
            parsed.code,
            &parsed.msg,
        )));
    }
    let token = parsed
        .tenant_access_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            // 注意这里**不**回显 body：成功分支的 body 里就是 token 本身
            AppError::api("飞书换取 token 成功但返回体里没有 tenant_access_token".to_string())
        })?;
    // 没给 expire 就按 0 处理 → 下次必定重取，比假设一个有效期安全
    let expires_at = now_unix() + parsed.expire.unwrap_or(0);

    tracing::info!(expires_at, "飞书 token：已换取（不记录 token 本身）");
    Ok(TokenCache { token, expires_at })
}

/// 第 1 步：`medias/upload_all`（multipart），`parent_type` 固定 [`PARENT_TYPE_IMPORT`]。
///
/// 上传用的 `file_name` 后缀必须与 [`create_import_task`] 传的 `file_extension` 一致，
/// 否则报 [`ERR_EXTENSION_MISMATCH`]。两处都用 [`normalized_extension`] 的结果，
/// 因此 `.markdown` 的源文件会以 `<主名>.md` 的名字上传 —— 内容一个字节没动，
/// 只是把「我们声明的后缀」和「我们上传的文件名」对齐到飞书认识的那一个值上。
pub async fn upload_media(token: &str, path: &Path) -> AppResult<String> {
    let raw_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    let extension = normalized_extension(raw_extension)
        .ok_or_else(|| AppError::api(format!("飞书导入不支持扩展名 .{raw_extension}")))?;

    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        // 取不到主名（纯扩展名文件、非 UTF-8 文件名）时给个中性名字，
        // 它会成为飞书云文档的标题，不能是空串
        .unwrap_or("document");
    let file_name = format!("{stem}.{extension}");

    let bytes = std::fs::read(path)
        .map_err(|err| AppError::not_found(format!("{}（{err}）", path.display())))?;
    let size = bytes.len();

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name.clone())
        .mime_str("application/octet-stream")
        .map_err(AppError::from)?;
    // parent_node：**本链路里唯一没有被事实库 #7 逐字钉死的字段**
    // （#7 钉的是接口名、调用顺序、20MB 上限、file_extension 一致性与最小权限集）。
    // 开放平台文档里它是「上传点的 token」，而导入场景没有真实的上传点，
    // 传的就是文件扩展名。若真机首测在**第 1 步**就失败，先看日志里飞书回的
    // code/msg 原文再动这里 —— 上传接口的错误码会直接指名是哪个字段不对，
    // 不要凭猜测换值。
    let form = reqwest::multipart::Form::new()
        .text("file_name", file_name.clone())
        .text("parent_type", PARENT_TYPE_IMPORT.to_string())
        .text("parent_node", extension.to_string())
        .text("size", size.to_string())
        .part("file", part);

    tracing::info!(%file_name, size, "飞书导入：上传素材");
    let response = http_client(UPLOAD_TIMEOUT_SECS)?
        .post(endpoint(PATH_UPLOAD_ALL))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await?;

    #[derive(Debug, Deserialize)]
    struct UploadData {
        file_token: String,
    }

    let data: UploadData = read_envelope("上传素材", response).await?;
    if data.file_token.is_empty() {
        return Err(AppError::api(
            "飞书上传素材返回了空的 file_token".to_string(),
        ));
    }
    tracing::info!("飞书导入：素材已上传");
    Ok(data.file_token)
}

/// 第 2 步：`POST import_tasks`（复数）创建导入任务，返回 ticket。
///
/// `point.mount_key` 传空字符串 = 挂到云空间根目录（DG 7.2-6）。
pub async fn create_import_task(
    token: &str,
    file_token: &str,
    extension: &str,
) -> AppResult<String> {
    let body = serde_json::json!({
        // 与 upload_media 上传时的文件名后缀必须逐字一致，否则 1069910
        "file_extension": extension,
        "file_token": file_token,
        "type": IMPORT_TARGET_TYPE,
        "point": {
            "mount_type": MOUNT_TYPE_CLOUD_SPACE,
            "mount_key": MOUNT_KEY_ROOT,
        },
    });

    tracing::info!(extension, "飞书导入：创建导入任务");
    let response = http_client(REQUEST_TIMEOUT_SECS)?
        .post(endpoint(PATH_IMPORT_TASKS))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;

    #[derive(Debug, Deserialize)]
    struct CreateData {
        ticket: String,
    }

    let data: CreateData = read_envelope("创建导入任务", response).await?;
    if data.ticket.is_empty() {
        return Err(AppError::api("飞书创建导入任务返回了空 ticket".to_string()));
    }
    Ok(data.ticket)
}

/// 查询导入任务的返回体。
#[derive(Debug, Deserialize)]
struct PollData {
    result: PollResult,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PollResult {
    /// 见 [`classify_job_status`]
    job_status: Option<i64>,
    job_error_msg: Option<String>,
    /// 成功后的云文档链接
    url: Option<String>,
    /// 成功后的文档 token（留着便于排查，不参与判定）
    token: Option<String>,
}

/// 把 `job_status` 归成三态。
///
/// 只钉死两个值：**0 = 成功**、**1/2 = 还在跑**（初始化 / 处理中）。
/// 其余一律当失败，原因以飞书自己回的 `job_error_msg` 为准。
///
/// 为什么不把每个错误码都枚举出来：那张表会随平台演进而变，
/// 抄一份进代码只会在它变化时产生「我们说成功、其实失败」这种最坏的错判。
/// 「非 0 非 1 非 2 即失败 + 原样透出 msg」永远不会过时。
fn classify_job_status(job_status: Option<i64>) -> ImportState {
    match job_status {
        Some(0) => ImportState::Succeeded,
        Some(1) | Some(2) => ImportState::Importing,
        // 字段缺失同样按「还在跑」处理：轮询自带次数上限，多转一圈的代价远小于误判失败
        None => ImportState::Importing,
        Some(_) => ImportState::Failed,
    }
}

/// 第 3 步：轮询 `GET import_tasks/:ticket` 直到成功 / 失败 / 超过 [`POLL_MAX_ATTEMPTS`]。
pub async fn poll_import_task(token: &str, ticket: &str) -> AppResult<ImportResult> {
    let url = format!("{}/{ticket}", endpoint(PATH_IMPORT_TASKS));

    for attempt in 1..=POLL_MAX_ATTEMPTS {
        let response = http_client(REQUEST_TIMEOUT_SECS)?
            .get(url.as_str())
            .bearer_auth(token)
            .send()
            .await?;
        let data: PollData = read_envelope("查询导入任务", response).await?;
        let state = classify_job_status(data.result.job_status);

        match state {
            ImportState::Succeeded => {
                tracing::info!(
                    attempt,
                    has_url = data.result.url.is_some(),
                    doc_token = data.result.token.as_deref().unwrap_or("-"),
                    "飞书导入：任务成功"
                );
                return Ok(ImportResult {
                    state,
                    url: data.result.url,
                    message: None,
                });
            }
            ImportState::Failed => {
                let message = data.result.job_error_msg.unwrap_or_else(|| {
                    format!(
                        "飞书导入任务失败（job_status={:?}，未给出原因）",
                        data.result.job_status
                    )
                });
                tracing::warn!(attempt, %message, "飞书导入：任务失败");
                return Ok(ImportResult {
                    state,
                    url: None,
                    message: Some(message),
                });
            }
            // Uploading 不会由本函数产生（那是第 1 步的状态），与 Importing 一同继续轮询
            ImportState::Uploading | ImportState::Importing => {
                tracing::debug!(attempt, "飞书导入：任务处理中");
                tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
            }
        }
    }

    Err(AppError::timeout(format!(
        "飞书导入任务在 {} 秒内未完成（ticket={ticket}）；文档可能仍在飞书侧转换，请稍后到云空间查看",
        POLL_MAX_ATTEMPTS as u64 * POLL_INTERVAL_MS / 1000
    )))
}

/// 把扩展名归一化成飞书认识的那一个值；不支持则 `None`。
///
/// `.markdown` 归到 `md`：内容完全一样，只是声明给飞书的后缀要用它认得的那个。
/// **归一化之后，上传的 file_name 与 file_extension 必须都用返回值**，
/// 否则就正好踩中 [`ERR_EXTENSION_MISMATCH`]。
fn normalized_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "md" | "markdown" => Some("md"),
        _ => None,
    }
}

/// 导入前置校验：大小 ≤ 20MB 且扩展名可被飞书识别。
pub fn precheck(byte_size: u64, extension: &str) -> AppResult<()> {
    if byte_size > MAX_IMPORT_BYTES {
        return Err(AppError::api(format!(
            "文件 {} 字节超过飞书导入上限 {} 字节，需降级默认通道",
            byte_size, MAX_IMPORT_BYTES
        )));
    }
    if normalized_extension(extension).is_none() {
        return Err(AppError::api(format!(
            "飞书导入不接受扩展名 .{}（file_extension 必须与实际后缀严格一致，否则报错码 {}）",
            extension, ERR_EXTENSION_MISMATCH
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 超过 20MB 必须在发请求之前就拦下并降级。
    #[test]
    fn rejects_oversized_file() {
        assert!(precheck(MAX_IMPORT_BYTES + 1, "md").is_err());
        assert!(precheck(MAX_IMPORT_BYTES, "md").is_ok());
    }

    /// 扩展名不匹配是 1069910 的根因，前置拦截。
    #[test]
    fn rejects_unsupported_extension() {
        assert!(precheck(1024, "mkd").is_err());
        assert!(precheck(1024, "markdown").is_ok());
    }

    /// 归一化：大小写无关，`.markdown` 收敛到 `md`，其余一律拒绝。
    ///
    /// 这条同时钉住了「上传文件名后缀」与「file_extension」的**唯一来源**：
    /// 两处都取本函数的返回值，就不可能出现只改一处导致的 1069910。
    #[test]
    fn normalizes_extension_to_a_single_value() {
        assert_eq!(normalized_extension("md"), Some("md"));
        assert_eq!(normalized_extension("MD"), Some("md"));
        assert_eq!(normalized_extension("markdown"), Some("md"));
        assert_eq!(normalized_extension("Markdown"), Some("md"));
        assert_eq!(normalized_extension("mkd"), None);
        assert_eq!(normalized_extension("txt"), None);
        assert_eq!(normalized_extension(""), None);
    }

    /// token 新鲜度必须扣掉刷新余量：还剩 1 分钟的 token 不算可用
    /// （上传 20MB 的时间比它长）。
    #[test]
    fn token_cache_respects_refresh_margin() {
        let now = 1_000_000;
        let fresh = TokenCache {
            token: "t-xxx".to_string(),
            expires_at: now + TOKEN_REFRESH_MARGIN_SECS + 1,
        };
        assert!(fresh.is_fresh(now));

        let edge = TokenCache {
            token: "t-xxx".to_string(),
            expires_at: now + TOKEN_REFRESH_MARGIN_SECS,
        };
        assert!(!edge.is_fresh(now), "刚好卡在余量上就该重取");

        let expired = TokenCache {
            token: "t-xxx".to_string(),
            expires_at: now - 1,
        };
        assert!(!expired.is_fresh(now));

        let empty = TokenCache {
            token: String::new(),
            expires_at: now + 99_999,
        };
        assert!(!empty.is_fresh(now), "空 token 永远不算新鲜");
    }

    /// 状态归类：只有 0 是成功，1/2 与缺字段继续等，其余一律失败。
    #[test]
    fn classifies_job_status() {
        assert_eq!(classify_job_status(Some(0)), ImportState::Succeeded);
        assert_eq!(classify_job_status(Some(1)), ImportState::Importing);
        assert_eq!(classify_job_status(Some(2)), ImportState::Importing);
        assert_eq!(classify_job_status(None), ImportState::Importing);
        for code in [3, 107, 108, 9999] {
            assert_eq!(
                classify_job_status(Some(code)),
                ImportState::Failed,
                "未知非零状态必须判失败：{code}"
            );
        }
    }

    /// 状态枚举的 wire 值是前后端契约（TS 侧是字面量联合类型）。
    #[test]
    fn serializes_import_state_contract() {
        let wire = |state: ImportState| serde_json::to_string(&state).expect("枚举可序列化");
        assert_eq!(wire(ImportState::Uploading), r#""uploading""#);
        assert_eq!(wire(ImportState::Importing), r#""importing""#);
        assert_eq!(wire(ImportState::Succeeded), r#""succeeded""#);
        assert_eq!(wire(ImportState::Failed), r#""failed""#);

        let value = serde_json::to_value(ImportResult {
            state: ImportState::Succeeded,
            url: Some("https://x.feishu.cn/docx/abc".to_string()),
            message: None,
        })
        .expect("序列化不应失败");
        assert_eq!(value["state"], "succeeded");
        assert!(value.get("url").is_some());
    }

    /// 端点必须是复数 `import_tasks`（事实库 #7 特意点名的坑）。
    #[test]
    fn endpoints_match_verified_facts() {
        assert_eq!(
            endpoint(PATH_IMPORT_TASKS),
            "https://open.feishu.cn/open-apis/drive/v1/import_tasks"
        );
        assert!(
            !PATH_IMPORT_TASKS.ends_with("import_task"),
            "接口是复数 import_tasks，单数会 404"
        );
        assert_eq!(
            endpoint(PATH_UPLOAD_ALL),
            "https://open.feishu.cn/open-apis/drive/v1/medias/upload_all"
        );
        assert_eq!(PARENT_TYPE_IMPORT, "ccm_import_open");
        assert_eq!(MAX_IMPORT_BYTES, 20 * 1024 * 1024);
    }

    /// 业务错误翻译：1069910 必须带上「后缀要一致」的提示，其余原样透出。
    #[test]
    fn explains_known_error_codes() {
        let mismatch = explain_lark_error("创建导入任务", ERR_EXTENSION_MISMATCH, "invalid ext");
        assert!(mismatch.contains("1069910"));
        assert!(mismatch.contains("严格一致"));

        // 其余错误码：原样透出 code + msg（飞书的 msg 是第一手信息，不许被我们吞掉）
        let unknown = explain_lark_error("上传素材", 123456, "boom");
        assert!(unknown.contains("123456") && unknown.contains("boom"));
        assert!(unknown.contains("发布"), "通用提示要提醒发布新版本");
        assert!(
            !unknown.contains("1069910"),
            "不相干的码不许被安上后缀不一致的解释"
        );
    }

    /// 响应体回显必须截断：出错时对端可能返回一整页 HTML。
    #[test]
    fn truncates_body_preview() {
        let long = "字".repeat(BODY_PREVIEW_CHARS * 2);
        let preview = body_preview(&long);
        assert_eq!(
            preview.chars().count(),
            BODY_PREVIEW_CHARS + 1,
            "多出的 1 个字符是省略号"
        );
        assert!(preview.ends_with('…'));

        let short = "{\"code\":0}";
        assert_eq!(body_preview(short), short, "短响应原样保留");
    }

    /// 信封解析：code≠0 要报错，code=0 缺 data 也要报错（不能当成功）。
    #[test]
    fn envelope_requires_code_zero_and_data() {
        #[derive(Debug, Deserialize)]
        struct Dummy {
            #[allow(dead_code)]
            ticket: String,
        }

        // 缺 code 的返回体（网关拦截页之类）必须解析失败
        assert!(serde_json::from_str::<LarkEnvelope<Dummy>>(r#"{"msg":"ok"}"#).is_err());

        let ok: LarkEnvelope<Dummy> =
            serde_json::from_str(r#"{"code":0,"msg":"ok","data":{"ticket":"t1"}}"#)
                .expect("正常返回体应能解析");
        assert_eq!(ok.code, 0);
        assert!(ok.data.is_some());

        let failed: LarkEnvelope<Dummy> =
            serde_json::from_str(r#"{"code":1069910,"msg":"bad ext"}"#).expect("错误体也应能解析");
        assert_eq!(failed.code, ERR_EXTENSION_MISMATCH);
        assert!(failed.data.is_none());
    }

    /// 轮询超时文案里的秒数要与常量对得上（改常量忘改文案会误导用户）。
    #[test]
    fn poll_budget_is_sixty_seconds() {
        assert_eq!(POLL_MAX_ATTEMPTS as u64 * POLL_INTERVAL_MS / 1000, 60);
    }
}
