interface Env {
    STATIC_CACHE: R2Bucket;
    API_KEY: string; // Read-only key
    WRITE_API_KEY: string; // Read-write key
}
