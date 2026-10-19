// macOS native observations and an egress blocker; the shell also denies network with Seatbelt.
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static char *observe_getenv(const char *name) {
    char *value = getenv(name);
    if (!strcmp(name, "ORT_DISABLE_TELEMETRY"))
        fprintf(stderr, "NATIVE_GETENV pid=%d ORT_DISABLE_TELEMETRY=%s\n", getpid(), value ? value : "<unset>");
    return value;
}

static int block_dns(const char *node, const char *service, const struct addrinfo *hints,
                     struct addrinfo **result) {
    if (node && strcmp(node, "localhost") && strcmp(node, "127.0.0.1") && strcmp(node, "::1")) {
        fprintf(stderr, "BLOCKED_DNS %s\n", node);
        return EAI_NONAME;
    }
    return getaddrinfo(node, service, hints, result);
}

static int block_connect(int fd, const struct sockaddr *addr, socklen_t length) {
    if (addr->sa_family == AF_INET || addr->sa_family == AF_INET6) {
        fprintf(stderr, "BLOCKED_CONNECT family=%d\n", addr->sa_family);
        errno = EACCES;
        return -1;
    }
    return connect(fd, addr, length);
}

#define INTERPOSE(replacement, original) \
    __attribute__((used)) static struct { const void *new_symbol; const void *old_symbol; } \
    interpose_##original __attribute__((section("__DATA,__interpose"))) = { \
        (const void *)(replacement), (const void *)(original) }
INTERPOSE(observe_getenv, getenv);
INTERPOSE(block_dns, getaddrinfo);
INTERPOSE(block_connect, connect);

// Observe the OS environment before JavaScript runs, including in the forked model owner.
__attribute__((constructor)) static void native_process_start(void) {
    fprintf(stderr, "NATIVE_PROCESS_START pid=%d ", getpid());
    observe_getenv("ORT_DISABLE_TELEMETRY");
}
