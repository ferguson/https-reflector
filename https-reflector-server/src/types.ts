export interface WebServerOptions {
    hostname: string;
    hostnames?: string[];       // normalized list (no *.), populated by WebServer constructor
    port?: number;
    bind?: string;
    use_https?: boolean;
    use_vhosts?: boolean;
    redirect_http?: boolean;
    redirect_port?: number;
    http_port?: number;
    https_port?: number;
    private_key_file?: string;
    certificate_file?: string;
    authority_file?: string;
    status_password?: string;
    dashboard_operators?: string;   // comma-separated identities that may change things on the dashboard
    dashboard_viewers?: string;     // ...and that may only look
    signin_plugins?: string;        // comma-separated paths of dashboard sign-in plugins (see DashboardAuth.ts)
    oidc_issuer?: string;           // a plain OpenID Connect provider for dashboard sign-in, without a plugin
    oidc_client_id?: string;
    oidc_client_secret?: string;
    oidc_label?: string;
    data_dir?: string;
}

export interface DeviceRecord {
    firstSeenAt: number;
    lastConnectedAt: number | null;
    lastDisconnectedAt: number | null;
    connectionCount: number;
    requestCount: number;
    bytesIn: number;
    bytesOut: number;
    connected: boolean;
    sessionStartAt: number | null;
    clientVersion: string | null;   // from the x-https-reflector-client header; null = legacy client
    lastRequestAt: number | null;   // last time a request was handed to this device
    lastActivityAt: number | null;  // last time bytes moved through one of its tunnels
    activeTunnels: number;          // proxied connections in flight right now (runtime only)
    archivedAt: number | null;      // hidden from the dashboard's main list (kept, and restorable)
}
