export interface WebServerOptions {
    hostname: string;
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
}
