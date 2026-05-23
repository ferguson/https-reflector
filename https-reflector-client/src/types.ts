export interface UplinkWSOptions {
    http_server_injection?: any;
    uplink_to_host: string;
    uplink_to_port: number;
}

export interface UplinkConnectorOptions extends UplinkWSOptions {
    pool_size?: number;
}

export interface HubUplinkClientOptions {
    http_server?: any;
    uplink_to_host?: string;
    uplink_to_port?: number;
}
