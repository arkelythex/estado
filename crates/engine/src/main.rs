use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    civictech_observability::init();

    let internal_token = std::env::var("ENGINE_INTERNAL_TOKEN").unwrap_or_default();
    if internal_token.trim().is_empty() {
        panic!("ENGINE_INTERNAL_TOKEN environment variable must be set");
    }

    let bind_addr =
        std::env::var("ENGINE_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8090".to_string());
    let addr: SocketAddr = bind_addr
        .parse()
        .unwrap_or_else(|err| panic!("invalid ENGINE_BIND_ADDR '{bind_addr}': {err}"));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {addr}: {err}"));

    tracing::info!(%addr, "civictech-engine listening");

    axum::serve(
        listener,
        civictech_engine::app(civictech_engine::EngineState::new(internal_token)),
    )
    .await
    .expect("civictech-engine server error");
}
