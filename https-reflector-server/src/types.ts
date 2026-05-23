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
}
