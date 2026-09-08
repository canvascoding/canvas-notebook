#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif

#define CANVAS_LANDLOCK_MIN_ABI 3
#define CANVAS_SANDBOX_UNAVAILABLE_EXIT 78

struct path_grant {
  const char *path;
  uint64_t access;
};

static uint64_t read_access(void) {
  return LANDLOCK_ACCESS_FS_EXECUTE |
         LANDLOCK_ACCESS_FS_READ_FILE |
         LANDLOCK_ACCESS_FS_READ_DIR;
}

static uint64_t write_access(void) {
  return read_access() |
         LANDLOCK_ACCESS_FS_WRITE_FILE |
         LANDLOCK_ACCESS_FS_REMOVE_DIR |
         LANDLOCK_ACCESS_FS_REMOVE_FILE |
         LANDLOCK_ACCESS_FS_MAKE_CHAR |
         LANDLOCK_ACCESS_FS_MAKE_DIR |
         LANDLOCK_ACCESS_FS_MAKE_REG |
         LANDLOCK_ACCESS_FS_MAKE_SOCK |
         LANDLOCK_ACCESS_FS_MAKE_FIFO |
         LANDLOCK_ACCESS_FS_MAKE_BLOCK |
         LANDLOCK_ACCESS_FS_MAKE_SYM |
         LANDLOCK_ACCESS_FS_REFER |
         LANDLOCK_ACCESS_FS_TRUNCATE;
}

static uint64_t file_write_access(void) {
  return LANDLOCK_ACCESS_FS_READ_FILE |
         LANDLOCK_ACCESS_FS_WRITE_FILE |
         LANDLOCK_ACCESS_FS_TRUNCATE;
}

static void fail(const char *message) {
  fprintf(stderr, "canvas-agent-landlock: %s\n", message);
  exit(EXIT_FAILURE);
}

static void fail_errno(const char *message) {
  fprintf(stderr, "canvas-agent-landlock: %s: %s\n", message, strerror(errno));
  exit(EXIT_FAILURE);
}

static void unavailable(const char *message) {
  fprintf(stderr, "canvas-agent-landlock: sandbox unavailable: %s\n", message);
  exit(CANVAS_SANDBOX_UNAVAILABLE_EXIT);
}

static int landlock_create_ruleset_call(
  const struct landlock_ruleset_attr *attr,
  size_t size,
  uint32_t flags
) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int landlock_add_rule_call(
  int ruleset_fd,
  enum landlock_rule_type type,
  const void *attr,
  uint32_t flags
) {
  return (int)syscall(__NR_landlock_add_rule, ruleset_fd, type, attr, flags);
}

static int landlock_restrict_self_call(int ruleset_fd, uint32_t flags) {
  return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

static int query_abi(void) {
  errno = 0;
  int abi = landlock_create_ruleset_call(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    unavailable(strerror(errno));
  }
  return abi;
}

static char *canonical_path(const char *path_value) {
  if (!path_value || path_value[0] != '/') {
    fail("granted paths and cwd must be absolute");
  }

  struct stat input_stats;
  if (lstat(path_value, &input_stats) != 0) {
    fail_errno("unable to inspect granted path");
  }
  if (S_ISLNK(input_stats.st_mode)) {
    fail("symlink roots are not accepted");
  }

  char *resolved = realpath(path_value, NULL);
  if (!resolved) {
    fail_errno("unable to canonicalize granted path");
  }
  if (strcmp(path_value, resolved) != 0) {
    free(resolved);
    fail("granted paths must already be canonical");
  }
  return resolved;
}

static void add_path_rule(int ruleset_fd, const struct path_grant *grant) {
  char *resolved = canonical_path(grant->path);
  int path_fd = open(resolved, O_PATH | O_CLOEXEC);
  if (path_fd < 0) {
    free(resolved);
    fail_errno("unable to open granted path");
  }

  struct landlock_path_beneath_attr rule = {
    .allowed_access = grant->access,
    .parent_fd = path_fd,
  };
  if (landlock_add_rule_call(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0) {
    close(path_fd);
    free(resolved);
    unavailable(strerror(errno));
  }

  close(path_fd);
  free(resolved);
}

static void close_inherited_descriptors(void) {
  long descriptor_limit = sysconf(_SC_OPEN_MAX);
  if (descriptor_limit < 0 || descriptor_limit > 1048576) {
    descriptor_limit = 65536;
  }
  for (int descriptor = 3; descriptor < descriptor_limit; descriptor += 1) {
    close(descriptor);
  }
}

static void print_usage(void) {
  fprintf(stderr,
    "Usage: canvas-agent-landlock [--probe] --cwd PATH "
    "[--ro PATH]... [--rw PATH]... [--rw-file PATH]... -- COMMAND [ARG]...\n");
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    print_usage();
    return EXIT_SUCCESS;
  }
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    int abi = query_abi();
    if (abi < CANVAS_LANDLOCK_MIN_ABI) {
      unavailable("Landlock ABI 3 or newer is required");
    }
    printf("%d\n", abi);
    return EXIT_SUCCESS;
  }

  struct path_grant *grants = calloc((size_t)argc, sizeof(struct path_grant));
  if (!grants) {
    fail_errno("unable to allocate grants");
  }
  size_t grant_count = 0;
  const char *cwd = NULL;
  int command_index = -1;

  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "--") == 0) {
      command_index = index + 1;
      break;
    }
    if (strcmp(argv[index], "--cwd") == 0 && index + 1 < argc) {
      cwd = argv[++index];
      continue;
    }
    if (index + 1 < argc && strcmp(argv[index], "--ro") == 0) {
      grants[grant_count++] = (struct path_grant){ argv[++index], read_access() };
      continue;
    }
    if (index + 1 < argc && strcmp(argv[index], "--rw") == 0) {
      grants[grant_count++] = (struct path_grant){ argv[++index], write_access() };
      continue;
    }
    if (index + 1 < argc && strcmp(argv[index], "--rw-file") == 0) {
      grants[grant_count++] = (struct path_grant){ argv[++index], file_write_access() };
      continue;
    }
    print_usage();
    return EXIT_FAILURE;
  }

  if (!cwd || command_index < 0 || command_index >= argc || grant_count == 0) {
    print_usage();
    return EXIT_FAILURE;
  }

  int abi = query_abi();
  if (abi < CANVAS_LANDLOCK_MIN_ABI) {
    unavailable("Landlock ABI 3 or newer is required");
  }

  const uint64_t handled_access = write_access();
  struct landlock_ruleset_attr ruleset = {
    .handled_access_fs = handled_access,
  };
  int ruleset_fd = landlock_create_ruleset_call(&ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) {
    unavailable(strerror(errno));
  }

  for (size_t index = 0; index < grant_count; index += 1) {
    add_path_rule(ruleset_fd, &grants[index]);
  }
  free(grants);

  char *resolved_cwd = canonical_path(cwd);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    close(ruleset_fd);
    free(resolved_cwd);
    unavailable(strerror(errno));
  }
  if (landlock_restrict_self_call(ruleset_fd, 0) != 0) {
    close(ruleset_fd);
    free(resolved_cwd);
    unavailable(strerror(errno));
  }
  close(ruleset_fd);

  if (chdir(resolved_cwd) != 0) {
    free(resolved_cwd);
    fail_errno("unable to enter working directory");
  }
  free(resolved_cwd);

  close_inherited_descriptors();
  execvp(argv[command_index], &argv[command_index]);
  fail_errno("unable to execute command");
  return EXIT_FAILURE;
}
