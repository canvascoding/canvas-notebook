/* Darwin descriptor primitives only. No authority, paths, JSON or child IO. */
#define NAPI_VERSION 8
#include <node_api.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef __APPLE__
#error The native descriptor addon is Darwin-only; Linux uses proc FD primitives.
#endif
#if defined(__arm64__) || defined(__aarch64__)
#define CANVAS_ARCH "arm64"
#elif defined(__x86_64__)
#define CANVAS_ARCH "x64"
#else
#error Unsupported Darwin architecture.
#endif
#define SCAN_LIMIT 100000

static napi_value refused(napi_env env, const char *code) {
  napi_throw_error(env, code, "The descriptor operation could not be confirmed.");
  return NULL;
}
static napi_value syscall_error(napi_env env, int error) {
  const char *code;
  switch (error) {
    case EBADF: code = "EBADF"; break; case EEXIST: code = "EEXIST"; break;
    case ENOENT: code = "ENOENT"; break; case ENOTDIR: code = "ENOTDIR"; break;
    case ELOOP: code = "ELOOP"; break; case EINVAL: code = "EINVAL"; break;
    case EACCES: code = "EACCES"; break; case EPERM: code = "EPERM"; break;
    case EXDEV: code = "EXDEV"; break; case ENOSPC: code = "ENOSPC"; break;
    case EMFILE: code = "EMFILE"; break; case ENFILE: code = "ENFILE"; break;
    case EROFS: code = "EROFS"; break; case ENAMETOOLONG: code = "ENAMETOOLONG"; break;
    case EIO: code = "EIO"; break; case EOVERFLOW: code = "EOVERFLOW"; break;
    default: code = "FD_PUBLICATION_UNCONFIRMED";
  }
  return refused(env, code);
}
static int arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *args) {
  size_t count = expected + 1;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != expected) {
    refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0;
  }
  return 1;
}
static int integer(napi_env env, napi_value input, double minimum, double maximum, double *value) {
  if (napi_get_value_double(env, input, value) != napi_ok || !isfinite(*value)
      || *value < minimum || *value > maximum || floor(*value) != *value) {
    refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0;
  }
  return 1;
}
static int directory(napi_env env, napi_value input, int *fd) {
  double value;
  if (!integer(env, input, 3, INT_MAX, &value)) return 0;
  *fd = (int)value;
  struct stat info;
  if (fstat(*fd, &info)) { syscall_error(env, errno); return 0; }
  if (!S_ISDIR(info.st_mode) || info.st_uid != geteuid() || info.st_nlink < 1 || (info.st_mode & 022)) {
    refused(env, "FD_PUBLICATION_NAMESPACE_CHANGED"); return 0;
  }
  return 1;
}
static int component(napi_env env, napi_value input, char *value) {
  size_t length, units_count, total_bytes, total_units;
  uint16_t units[NAME_MAX + 1];
  if (napi_get_value_string_utf16(env, input, NULL, 0, &total_units) != napi_ok || total_units > NAME_MAX
      || napi_get_value_string_utf8(env, input, NULL, 0, &total_bytes) != napi_ok || !total_bytes || total_bytes > NAME_MAX
      || napi_get_value_string_utf16(env, input, units, NAME_MAX + 1, &units_count) != napi_ok || units_count != total_units) {
    refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0;
  }
  for (size_t i = 0; i < units_count; i++) {
    if (units[i] >= 0xd800 && units[i] <= 0xdbff) {
      if (++i >= units_count || units[i] < 0xdc00 || units[i] > 0xdfff) {
        refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0;
      }
    } else if (units[i] >= 0xdc00 && units[i] <= 0xdfff) {
      refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0;
    }
  }
  if (napi_get_value_string_utf8(env, input, value, NAME_MAX + 1, &length) != napi_ok || length != total_bytes
      || strlen(value) != length || !strcmp(value, ".") || !strcmp(value, "..")) {
    refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0;
  }
  for (size_t i = 0; i < length; i++) if ((unsigned char)value[i] < 32 || value[i] == 127 || value[i] == '/' || value[i] == '\\') {
    refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0;
  }
  return 1;
}
static int regular(const struct stat *info) {
  return S_ISREG(info->st_mode) && info->st_uid == geteuid() && info->st_nlink >= 1 && info->st_nlink <= 2 && !(info->st_mode & 022);
}
static napi_value nothing(napi_env env) { napi_value value; napi_get_undefined(env, &value); return value; }
static napi_value descriptor(napi_env env, int fd) {
  napi_value value;
  if (napi_create_int32(env, fd, &value) != napi_ok) { close(fd); return refused(env, "FD_PUBLICATION_UNCONFIRMED"); }
  return value;
}
static napi_value open_directory(napi_env env, napi_callback_info info) {
  napi_value args[3]; int parent; char name[NAME_MAX + 1];
  if (!arguments(env, info, 2, args) || !directory(env, args[0], &parent) || !component(env, args[1], name)) return NULL;
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return syscall_error(env, errno);
  struct stat observed;
  if (fstat(fd, &observed)) { int error = errno; close(fd); return syscall_error(env, error); }
  if (!S_ISDIR(observed.st_mode) || observed.st_uid != geteuid() || observed.st_nlink < 1 || (observed.st_mode & 022)) {
    close(fd); return refused(env, "FD_PUBLICATION_NAMESPACE_CHANGED");
  }
  return descriptor(env, fd);
}
static napi_value open_file(napi_env env, napi_callback_info info) {
  napi_value args[4]; int parent; char name[NAME_MAX + 1], mode[NAME_MAX + 1];
  if (!arguments(env, info, 3, args) || !directory(env, args[0], &parent) || !component(env, args[1], name) || !component(env, args[2], mode)) return NULL;
  int flags = !strcmp(mode, "readonly") ? O_RDONLY : !strcmp(mode, "private-wx") ? O_WRONLY | O_CREAT | O_EXCL : -1;
  if (flags == -1) return refused(env, "FD_PUBLICATION_INVALID_INPUT");
  int fd = openat(parent, name, flags | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
  if (fd < 0) return syscall_error(env, errno);
  struct stat observed;
  if (fstat(fd, &observed)) { int error = errno; close(fd); return syscall_error(env, error); }
  if (!regular(&observed)) { close(fd); return refused(env, "FD_PUBLICATION_NON_REGULAR"); }
  return descriptor(env, fd);
}
static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value args[4]; int parent; char name[NAME_MAX + 1]; double mode;
  if (!arguments(env, info, 3, args) || !directory(env, args[0], &parent) || !component(env, args[1], name) || !integer(env, args[2], 0700, 0755, &mode)) return NULL;
  if (mode != 0700 && mode != 0755) return refused(env, "FD_PUBLICATION_INVALID_INPUT");
  if (mkdirat(parent, name, (mode_t)mode)) return syscall_error(env, errno);
  return nothing(env);
}
static napi_value link_at(napi_env env, napi_callback_info info) {
  napi_value args[5]; int source, target; char source_name[NAME_MAX + 1], target_name[NAME_MAX + 1];
  if (!arguments(env, info, 4, args) || !directory(env, args[0], &source) || !component(env, args[1], source_name)
      || !directory(env, args[2], &target) || !component(env, args[3], target_name)) return NULL;
  struct stat observed;
  if (fstatat(source, source_name, &observed, AT_SYMLINK_NOFOLLOW)) return syscall_error(env, errno);
  if (!regular(&observed)) return refused(env, "FD_PUBLICATION_NON_REGULAR");
  if (linkat(source, source_name, target, target_name, 0)) return syscall_error(env, errno);
  return nothing(env);
}
static int decimal(napi_env env, napi_value input, uint64_t *value) {
  char text[NAME_MAX + 1]; if (!component(env, input, text)) return 0;
  if (strlen(text) > 20 || (text[0] == '0' && text[1])) { refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0; }
  for (char *at = text; *at; at++) if (*at < '0' || *at > '9') { refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0; }
  errno = 0; char *end; unsigned long long result = strtoull(text, &end, 10);
  if (errno || *end) { refused(env, "FD_PUBLICATION_INVALID_INPUT"); return 0; }
  *value = (uint64_t)result; return 1;
}
static napi_value unlink_file(napi_env env, napi_callback_info info) {
  napi_value args[7]; int parent; char name[NAME_MAX + 1]; uint64_t dev, ino; double uid, mode;
  if (!arguments(env, info, 6, args) || !directory(env, args[0], &parent) || !component(env, args[1], name)
      || !decimal(env, args[2], &dev) || !decimal(env, args[3], &ino) || !integer(env, args[4], 0, UINT32_MAX, &uid)
      || !integer(env, args[5], 0600, 0600, &mode)) return NULL;
  if (!ino || uid != geteuid()) return refused(env, "FD_PUBLICATION_INVALID_INPUT");
  struct stat observed;
  if (fstatat(parent, name, &observed, AT_SYMLINK_NOFOLLOW)) return syscall_error(env, errno);
  if (!regular(&observed)) return refused(env, "FD_PUBLICATION_NON_REGULAR");
  if ((uint64_t)observed.st_dev != dev || (uint64_t)observed.st_ino != ino || observed.st_uid != (uid_t)uid
      || (observed.st_mode & 07777) != 0600) return refused(env, "FD_PUBLICATION_PROFILE_CHANGED");
  if (unlinkat(parent, name, 0)) return syscall_error(env, errno);
  return nothing(env);
}
static napi_value exact_name(napi_env env, napi_callback_info info) {
  napi_value args[3], result; int parent; char name[NAME_MAX + 1];
  if (!arguments(env, info, 2, args) || !directory(env, args[0], &parent) || !component(env, args[1], name)) return NULL;
  /* A fresh description avoids consuming the caller's directory cursor. */
  int fd = openat(parent, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return syscall_error(env, errno);
  DIR *stream = fdopendir(fd);
  if (!stream) { int error = errno; close(fd); return syscall_error(env, error); }
  int count = 0, found = 0, error = 0;
  for (;;) {
    errno = 0; struct dirent *entry = readdir(stream);
    if (!entry) { error = errno; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > SCAN_LIMIT) { error = EOVERFLOW; break; }
    if (!strcmp(entry->d_name, name)) { found = 1; break; }
  }
  if (closedir(stream) && !error) error = errno;
  if (error == EOVERFLOW) return refused(env, "FD_PUBLICATION_SCAN_LIMIT");
  if (error) return syscall_error(env, error);
  napi_get_boolean(env, found, &result); return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  const char *names[] = {"openDirectoryAt", "openFileAt", "mkdirAt", "linkAt", "unlinkFileAt", "hasExactNameAt"};
  napi_callback functions[] = {open_directory, open_file, mkdir_at, link_at, unlink_file, exact_name};
  for (int i = 0; i < 6; i++) { napi_value fn; napi_create_function(env, names[i], NAPI_AUTO_LENGTH, functions[i], NULL, &fn); napi_set_named_property(env, exports, names[i], fn); }
  napi_value version, napi, platform, arch;
  napi_create_int32(env, 1, &version); napi_set_named_property(env, exports, "apiVersion", version);
  napi_create_int32(env, 8, &napi); napi_set_named_property(env, exports, "napiVersion", napi);
  napi_create_string_utf8(env, "darwin", NAPI_AUTO_LENGTH, &platform); napi_set_named_property(env, exports, "platform", platform);
  napi_create_string_utf8(env, CANVAS_ARCH, NAPI_AUTO_LENGTH, &arch); napi_set_named_property(env, exports, "arch", arch);
  if (napi_object_freeze(env, exports) != napi_ok) return refused(env, "FD_PUBLICATION_UNCONFIRMED");
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
