//! 全局错误类型（AI_DEV_GUIDE 第 5 节 Rust 规范）。
//!
//! 约定：每个 `#[tauri::command]` 一律返回 `Result<T, AppError>`。
//! 错误文案面向**日志与排查**，不是给终端用户看的；用户可见文案由前端
//! `i18n/zh-CN.ts` 决定，前端按序列化出来的 `kind` 字段做映射，
//! 因此 `kind()` 的取值是前后端契约，改动需同步前端。

use serde::{Serialize, Serializer};
use thiserror::Error;

/// 命令层统一返回类型。
pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    /// 骨架阶段占位：命令已注册但尚未实现（比 `todo!()` 安全——不会 panic 掉整个应用）。
    #[error("功能尚未实现：{0}")]
    NotImplemented(String),

    /// 文件不存在、被移动或无权限访问（FR-06 警示条的后端来源）。
    #[error("文件不存在或无法访问：{0}")]
    NotFound(String),

    #[error("IO 错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 解析/序列化失败：{0}")]
    Json(#[from] serde_json::Error),

    #[error("Tauri 运行时错误：{0}")]
    Tauri(#[from] tauri::Error),

    #[error("网络请求失败：{0}")]
    Http(#[from] reqwest::Error),

    /// 第三方 API 返回业务错误（如飞书 code=1069910：file_extension 与后缀不一致）。
    #[error("接口返回错误：{0}")]
    Api(String),

    /// 编码检测/解码失败（UTF-8 → GBK 兜底后仍失败，DG 8「编码」）。
    #[error("编码解析失败：{0}")]
    Encoding(String),

    /// 原生调用失败：COM（PrintToPdf）、CDP、注册表、外部进程等。
    #[error("原生调用失败：{0}")]
    Native(String),

    /// 超时（PDF 导出 30s、长图截图等，DG 7.2-4）。
    #[error("操作超时：{0}")]
    Timeout(String),

    /// 配置/环境问题（%APPDATA% 缺失、settings.json 损坏、命令行参数非法等）。
    #[error("配置错误：{0}")]
    Config(String),
}

impl AppError {
    /// 前后端契约：错误种类标识，前端据此选择用户可见文案。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NotImplemented(_) => "not-implemented",
            Self::NotFound(_) => "not-found",
            Self::Io(_) => "io",
            Self::Json(_) => "json",
            Self::Tauri(_) => "tauri",
            Self::Http(_) => "http",
            Self::Api(_) => "api",
            Self::Encoding(_) => "encoding",
            Self::Native(_) => "native",
            Self::Timeout(_) => "timeout",
            Self::Config(_) => "config",
        }
    }

    pub fn not_implemented(what: impl Into<String>) -> Self {
        Self::NotImplemented(what.into())
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        Self::NotFound(what.into())
    }

    pub fn api(what: impl Into<String>) -> Self {
        Self::Api(what.into())
    }

    pub fn encoding(what: impl Into<String>) -> Self {
        Self::Encoding(what.into())
    }

    pub fn native(what: impl Into<String>) -> Self {
        Self::Native(what.into())
    }

    pub fn timeout(what: impl Into<String>) -> Self {
        Self::Timeout(what.into())
    }

    pub fn config(what: impl Into<String>) -> Self {
        Self::Config(what.into())
    }
}

/// tauri command 的错误类型必须可序列化；序列化成 `{ kind, message }` 而非裸字符串，
/// 前端才能稳定地按 kind 分支处理。
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 错误必须序列化成 { kind, message } 两个字段（前后端契约）。
    #[test]
    fn serializes_into_kind_and_message() {
        let err = AppError::not_found("D:\\不存在.md");
        let value = serde_json::to_value(&err).expect("序列化不应失败");
        assert_eq!(value["kind"], "not-found");
        assert!(value["message"].as_str().unwrap().contains("不存在.md"));
    }
}
