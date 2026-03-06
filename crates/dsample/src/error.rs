#[derive(Debug, thiserror::Error)]
pub enum DsampleError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Invalid argument: {0}")]
    InvalidArg(String),
}
