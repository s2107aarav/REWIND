#ifdef __linux__
#define _GNU_SOURCE
#else
#define _DARWIN_C_SOURCE
#endif
#include <stdio.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/file.h>
#ifdef __linux__
#include <sys/syscall.h>
#include <linux/fs.h>
#endif

/* Locks belong to the inherited open file description until its owner closes it. */
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--lock") == 0) {
        if (flock(3, LOCK_EX | LOCK_NB) == 0) return 0;
        int failure = errno;
        fprintf(stderr, "%s\n", strerror(failure));
        return (failure == EWOULDBLOCK || failure == EAGAIN) ? 4 : 1;
    }
    if (argc != 3) { fprintf(stderr, "Expected stage and destination\n"); return 2; }
#ifdef __APPLE__
    int result = renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
    int result = syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE);
#else
    fprintf(stderr, "Atomic exclusive publication unsupported on this platform\n");
    return 3;
#endif
#if defined(__APPLE__) || (defined(__linux__) && defined(SYS_renameat2))
    if (result != 0) { fprintf(stderr, "%s\n", strerror(errno)); return errno == EEXIST ? 4 : 1; }
    return 0;
#endif
}
