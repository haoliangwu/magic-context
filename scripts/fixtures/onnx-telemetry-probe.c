// A Linux-only probe: observe native getenv and deny outbound connections before any data leaves.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <netdb.h>
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

static char *(*real_getenv)(const char *);
char *getenv(const char *name) {
    if (!real_getenv) real_getenv = dlsym(RTLD_NEXT, "getenv");
    char *value = real_getenv(name);
    if (!strcmp(name, "ORT_DISABLE_TELEMETRY"))
        fprintf(stderr, "NATIVE_GETENV ORT_DISABLE_TELEMETRY=%s\n", value ? value : "<unset>");
    return value;
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
                struct addrinfo **result) {
    static int (*real_getaddrinfo)(const char *, const char *, const struct addrinfo *, struct addrinfo **);
    if (!real_getaddrinfo) real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");
    if (node && strcmp(node, "localhost") && strcmp(node, "127.0.0.1") && strcmp(node, "::1")) {
        fprintf(stderr, "BLOCKED_DNS %s\n", node);
        return EAI_NONAME;
    }
    return real_getaddrinfo(node, service, hints, result);
}

int connect(int fd, const struct sockaddr *addr, socklen_t length) {
    static int (*real_connect)(int, const struct sockaddr *, socklen_t);
    if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
    if (addr->sa_family == AF_INET || addr->sa_family == AF_INET6) {
        char host[INET6_ADDRSTRLEN];
        const void *ip = addr->sa_family == AF_INET
            ? (void *)&((const struct sockaddr_in *)addr)->sin_addr
            : (void *)&((const struct sockaddr_in6 *)addr)->sin6_addr;
        inet_ntop(addr->sa_family, ip, host, sizeof(host));
        fprintf(stderr, "BLOCKED_CONNECT %s\n", host);
        errno = ENETUNREACH;
        return -1;
    }
    return real_connect(fd, addr, length);
}

static napi_value read_native_env(napi_env env, napi_callback_info info) {
    napi_value value;
    const char *text = getenv("ORT_DISABLE_TELEMETRY");
    if (text) napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
    else napi_get_null(env, &value);
    return value;
}

NAPI_MODULE_INIT() {
    napi_value fn;
    napi_create_function(env, "readNativeEnv", NAPI_AUTO_LENGTH, read_native_env, NULL, &fn);
    napi_set_named_property(env, exports, "readNativeEnv", fn);
    return exports;
}
