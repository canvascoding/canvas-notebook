#!/usr/bin/env python3
"""Private create-only birth IO. fd3 pins DATA, fd4 pins the actual workspace.

The caller holds genuine Owner A until this helper closes. This process only
prepares private records/twins and reads target identities. The parent freshly
authorizes and performs the public mkdir/link synchronously after child close.
Equal bytes never attribute a peer inode. No target mutation/auth/SQL occurs here.
"""
import base64
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import uuid

LIMIT = 5 * 1024 * 1024
RECORD_LIMIT = 128 * 1024
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
STORE = 'canvas-markdown-create-births'
ANCHOR = STORE + '-anchor.json'


class Refused(Exception):
    pass


def fail(code):
    raise Refused('MARKDOWN_CREATE_BIRTH_' + code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def decode(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail('RECORD_CHANGED')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def identity(info):
    return {'dev': str(info.st_dev), 'ino': str(info.st_ino), 'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)}


def file_identity(info):
    # Darwin exposes immutable birth time; settled ctime below also prevents
    # inode-number reuse from passing a completed-claim comparison on Linux.
    return {**identity(info), 'size': info.st_size, 'mtimeNs': str(info.st_mtime_ns),
            'birthTime': str(getattr(info, 'st_birthtime_ns', getattr(info, 'st_birthtime', None)))}


def directory(fd, private=False):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & (0o077 if private else 0o022):
        fail('NAMESPACE_CHANGED')
    return identity(info)


def named(parent, name, fd):
    value = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if identity(value) != identity(os.fstat(fd)) or not stat.S_ISDIR(value.st_mode):
        fail('NAMESPACE_CHANGED')


def open_dir(parent, name, private=False):
    fd = os.open(name, DIRECTORY, dir_fd=parent)
    try:
        directory(fd, private)
        named(parent, name, fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def directory_entries(parent):
    # A fresh description of the pinned directory avoids stale enumeration
    # state on Linux and never consumes the caller's directory cursor. A dup
    # would share that description; resolving a pathname could select a peer.
    fd = os.open('.', DIRECTORY | os.O_CLOEXEC, dir_fd=parent)
    try:
        return os.listdir(fd)
    finally:
        os.close(fd)


def read_file(parent, name, limit=RECORD_LIMIT, links=1):
    fd = os.open(name, READ, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != links or before.st_size > limit:
            fail('RECORD_CHANGED')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(64 * 1024, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                fail('RECORD_CHANGED')
        after = os.fstat(fd)
        observed = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if file_identity(before) != file_identity(after) or before.st_ctime_ns != after.st_ctime_ns or before.st_nlink != after.st_nlink \
                or file_identity(after) != file_identity(observed) or after.st_nlink != observed.st_nlink:
            fail('RECORD_CHANGED')
        return b''.join(chunks), file_identity(after)
    finally:
        os.close(fd)


def optional_record(parent, name):
    try:
        data, _ = read_file(parent, name)
    except FileNotFoundError:
        return None
    value = decode(data)
    if encode(value) != data or stat.S_IMODE(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode) != 0o600:
        fail('RECORD_CHANGED')
    return value


def ack(stage):
    print(json.dumps({'stage': stage}), flush=True)
    if sys.stdin.readline().strip() != 'continue':
        fail('ACK_REQUIRED')


def record(parent, name, value):
    data = encode(value)
    if len(data) > RECORD_LIMIT:
        fail('RECORD_CHANGED')
    prior = optional_record(parent, name)
    if prior is not None:
        if prior != value:
            fail('RECORD_CHANGED')
        return
    # An unconfirmed pending record is retained, never adopted as a final one.
    temp = name + '.pending'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                fail('IO_UNCONFIRMED')
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
    os.fsync(parent)
    os.unlink(temp, dir_fd=parent)
    os.fsync(parent)


def store_anchor(data, settle=True):
    """Resolve only a published private pointer; never search/adopt orphans."""
    try:
        info = os.stat(ANCHOR, dir_fd=data, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 \
            or info.st_nlink not in (1, 2) or ANCHOR not in directory_entries(data):
        fail('NAMESPACE_CHANGED')
    raw, observed = read_file(data, ANCHOR, RECORD_LIMIT, info.st_nlink)
    value = decode(raw)
    if not isinstance(value, dict) or encode(value) != raw or observed != file_identity(info) \
            or value.get('data') != directory(data):
        fail('NAMESPACE_CHANGED')
    if value.get('version') == 1:
        # Only settled V1 is a supported legacy store. Its unfinished anchor
        # lacks the explicit pointer inode/name binding of the V2 protocol.
        if info.st_nlink != 1 or set(value) != {'version', 'data', 'store'}:
            fail('RECOVERY_REQUIRED')
        name = STORE
    elif value.get('version') == 2:
        if set(value) != {'version', 'data', 'storeName', 'store', 'pendingName', 'pointerFile'} \
                or not isinstance(value['storeName'], str) or not re.fullmatch(STORE + '-[a-f0-9]{32}', value['storeName']) \
                or value['pendingName'] != 'anchor.pending' or value['pointerFile'] != identity(info):
            fail('NAMESPACE_CHANGED')
        name = value['storeName']
    else:
        fail('NAMESPACE_CHANGED')
    store = open_dir(data, name, True)
    try:
        if name not in directory_entries(data) or directory(store, True) != value['store']:
            fail('NAMESPACE_CHANGED')
        if value['version'] == 2:
            pending = value['pendingName']
            if info.st_nlink == 2:
                twin, profile = read_file(store, pending, RECORD_LIMIT, 2)
                if pending not in directory_entries(store) or twin != raw or profile != observed \
                        or {key: profile[key] for key in ['dev', 'ino', 'uid', 'mode']} != value['pointerFile']:
                    fail('RECORD_CHANGED')
                if not settle:
                    fail('RECOVERY_REQUIRED')
                # Only this exact private 0600 two-link twin may be removed.
                named(data, name, store)
                current, current_profile = read_file(data, ANCHOR, RECORD_LIMIT, 2)
                if current != raw or current_profile != observed:
                    fail('NAMESPACE_CHANGED')
                current = os.stat(pending, dir_fd=store, follow_symlinks=False)
                if file_identity(current) != observed or current.st_nlink != 2:
                    fail('RECORD_CHANGED')
                os.unlink(pending, dir_fd=store)
            else:
                try:
                    os.stat(pending, dir_fd=store, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    fail('RECORD_CHANGED')
            # Also settle an observed link/unlink whose caller died before
            # acknowledging directory durability. The pointer itself is fixed.
            if settle:
                os.fsync(store)
                os.fsync(data)
            settled, profile = read_file(data, ANCHOR, RECORD_LIMIT, 1)
            if settled != raw or profile != observed:
                fail('NAMESPACE_CHANGED')
        named(data, name, store)
        return name, store
    except BaseException:
        os.close(store)
        raise


def claim_store(data):
    # Global initialization is independent of workspace A, so serialize it with
    # an actual kernel lock. Unknown directories are never silently adopted.
    lock = os.open(STORE + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=data)
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            fail('NAMESPACE_CHANGED')
        fcntl.flock(lock, fcntl.LOCK_EX)
        named_lock = os.stat(STORE + '.lock', dir_fd=data, follow_symlinks=False)
        if identity(named_lock) != identity(info) or named_lock.st_nlink != 1:
            fail('NAMESPACE_CHANGED')
        existing = store_anchor(data)
        if existing is not None:
            return existing
        # Unique unpublished candidates are retained after failure, never
        # adopted or deleted. No crash can reserve the one final store name.
        for _ in range(16):
            name = STORE + '-' + uuid.uuid4().hex
            try:
                os.mkdir(name, 0o700, dir_fd=data)
                break
            except FileExistsError:
                continue
        else:
            fail('IO_UNCONFIRMED')
        store = open_dir(data, name, True)
        try:
            pending = 'anchor.pending'
            fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=store)
            try:
                expected = {'version': 2, 'data': directory(data), 'storeName': name, 'store': directory(store, True),
                            'pendingName': pending, 'pointerFile': identity(os.fstat(fd))}
                if expected['pointerFile']['mode'] != 0o600:
                    fail('RECORD_CHANGED')
                encoded = encode(expected)
                view = memoryview(encoded)
                while view:
                    count = os.write(fd, view)
                    if count <= 0:
                        fail('IO_UNCONFIRMED')
                    view = view[count:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(store)
            os.fsync(data)
            named(data, name, store)
            try:
                os.link(pending, ANCHOR, src_dir_fd=store, dst_dir_fd=data, follow_symlinks=False)
            except FileExistsError:
                # A winner is validated exactly like a restart. The losing
                # readiness candidate stays untouched for explicit inspection.
                pass
            os.fsync(data)
            selected = store_anchor(data)
            if selected is None:
                fail('IO_UNCONFIRMED')
            return selected
        finally:
            os.close(store)
    finally:
        os.close(lock)


def existing_claim_store(data):
    """Observe an existing settled store without initializing or repairing it."""
    try:
        lock = os.open(STORE + '.lock', READ, dir_fd=data)
    except FileNotFoundError:
        fail('RECORD_CHANGED')
    try:
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            fail('NAMESPACE_CHANGED')
        fcntl.flock(lock, fcntl.LOCK_SH)
        named_lock = os.stat(STORE + '.lock', dir_fd=data, follow_symlinks=False)
        if identity(named_lock) != identity(info) or named_lock.st_nlink != 1:
            fail('NAMESPACE_CHANGED')
        existing = store_anchor(data, settle=False)
        if existing is None:
            fail('RECORD_CHANGED')
        return existing
    finally:
        os.close(lock)


def parent_for(root, target, initial, parents):
    opened, parent, relative = [], root, ''
    try:
        for segment in target.split('/')[:-1]:
            relative = segment if not relative else relative + '/' + segment
            expected = initial.get(relative) or parents.get(relative)
            if expected is None:
                # This helper never creates public parents. The synchronous
                # parent must bind any new directory before linking its target.
                try:
                    os.stat(segment, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    return None, opened
                fail('TARGET_CHANGED')
            else:
                child = open_dir(parent, segment)
                opened.append(child)
                if directory(child) != expected:
                    fail('TARGET_CHANGED')
            # Exact case/name matters even on a case-insensitive filesystem.
            if segment not in directory_entries(parent):
                fail('TARGET_CHANGED')
            parent = child
        return parent, opened
    except BaseException:
        for fd in reversed(opened):
            os.close(fd)
        raise


def capture_absence(root, target, manual_new=False):
    result, opened, parent, relative, missing = {}, [], root, '', False
    try:
        for segment in target.split('/'):
            relative = segment if not relative else relative + '/' + segment
            if missing:
                result[relative] = None
                continue
            try:
                value = os.stat(segment, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                missing = True
                result[relative] = None
                continue
            if manual_new and relative == target:
                fail('MANUAL_PATH_EXISTS')
            if relative == target or not stat.S_ISDIR(value.st_mode) or segment not in directory_entries(parent):
                fail('TARGET_CHANGED')
            child = open_dir(parent, segment)
            opened.append(child)
            result[relative] = directory(child)
            parent = child
        return result
    finally:
        for fd in reversed(opened):
            os.close(fd)


def assert_parents(root, target, opened):
    parent = root
    for segment, child in zip(target.split('/')[:-1], opened):
        named(parent, segment, child)
        if segment not in directory_entries(parent):
            fail('TARGET_CHANGED')
        parent = child


def direct_mcp_attribution(intent):
    """Exact original metadata only; real authorization belongs to Node A/D."""
    selected, origin = intent.get('source'), intent.get('origin')
    keys = {'kind', 'workspaceId', 'targetPath', 'actorUserId', 'actorSessionId', 'clientId', 'tool',
            'operationId', 'requestId', 'ingestRequestFingerprint', 'sourceHash', 'sourceBytes', 'fileId', 'declaredMimeType', 'ingestValidationJson'}
    def length(value):
        return len(value.encode('utf-16-le', errors='surrogatepass')) // 2
    def bounded(value, maximum=200):
        return isinstance(value, str) and 0 < length(value) <= maximum
    if not isinstance(selected, dict) or set(selected) != keys or not isinstance(origin, dict) \
            or selected.get('kind') != 'direct-mcp-markdown-v1' or selected.get('tool') not in ('create_knowledge_source', 'import_knowledge_file') \
            or not bounded(selected.get('workspaceId')) or not all(bounded(selected.get(key), 256) for key in ['actorUserId', 'actorSessionId', 'clientId']) \
            or not all(isinstance(selected.get(key), str) and re.fullmatch('[a-f0-9]{64}', selected[key]) for key in ['operationId', 'ingestRequestFingerprint', 'sourceHash']) \
            or selected['requestId'] != 'mcp-create:' + selected['operationId'] or selected['operationId'] != intent.get('operationId') \
            or any(selected.get(key) != origin.get(other) for key, other in [('workspaceId', 'workspaceId'), ('actorUserId', 'userId'),
                       ('actorSessionId', 'sessionId'), ('clientId', 'clientId'), ('tool', 'tool')]) \
            or not bounded(selected.get('targetPath'), 1024) or selected['targetPath'] != intent.get('targetPath') \
            or not re.search(r'\.(?:md|markdown)$', selected['targetPath'], re.IGNORECASE) \
            or any(not name or name.startswith('.') or re.search(r'[\\\x00-\x1f\x7f]', name) for name in selected['targetPath'].split('/')) \
            or type(selected.get('sourceBytes')) is not int or not 0 <= selected['sourceBytes'] <= 512 * 1024:
        fail('SOURCE_CHANGED')
    if selected['tool'] == 'create_knowledge_source':
        if selected['fileId'] is not None or selected['declaredMimeType'] is not None:
            fail('SOURCE_CHANGED')
    elif not bounded(selected['fileId']) or selected['declaredMimeType'] is not None and \
            not bounded(selected['declaredMimeType']):
        fail('SOURCE_CHANGED')
    raw = selected['ingestValidationJson']
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > 32 * 1024:
        fail('SOURCE_CHANGED')
    validation = decode(raw.encode('utf-8'))
    if not isinstance(validation, dict) or set(validation) != {'mimeType', 'markdown', 'warnings'} \
            or json.dumps(validation, separators=(',', ':'), ensure_ascii=False) != raw \
            or not isinstance(validation['mimeType'], str) or length(validation['mimeType']) > 200 \
            or not re.fullmatch(r'[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+', validation['mimeType']) \
            or not isinstance(validation['warnings'], list) or len(validation['warnings']) > 64:
        fail('SOURCE_CHANGED')
    markdown = validation['markdown']
    if markdown is not None and (not isinstance(markdown, dict) or 'mode' not in markdown or set(markdown) - {'mode', 'reason'} \
            or markdown['mode'] not in ('rich', 'normalizable', 'source') \
            or 'reason' in markdown and (not isinstance(markdown['reason'], str) or length(markdown['reason']) > 200)):
        fail('SOURCE_CHANGED')
    for warning in validation['warnings']:
        if not isinstance(warning, dict) or set(warning) != {'code', 'message'} or not bounded(warning.get('code')) \
                or not isinstance(warning.get('message'), str) or length(warning['message']) > 4096:
            fail('SOURCE_CHANGED')
    return dict(selected)


def agent_attribution(intent):
    """Mechanical original PI source metadata; never an authentication grant."""
    selected, origin = intent.get('source'), intent.get('origin')
    keys = {'kind', 'workspaceId', 'targetPath', 'actorUserId', 'actorSessionId', 'agentId', 'toolName', 'toolCallId',
            'operationId', 'requestId', 'requestFingerprint', 'sourceHash', 'sourceBytes'}
    def units(value):
        return len(value.encode('utf-16-le', errors='surrogatepass')) // 2
    if not isinstance(selected, dict) or set(selected) != keys or not isinstance(origin, dict) \
            or selected.get('kind') != 'agent-markdown-v1' or selected.get('toolName') not in ('write', 'pdf_to_markdown') \
            or not all(isinstance(selected.get(key), str) and 0 < units(selected[key]) <= 256
                       for key in ['workspaceId', 'actorUserId', 'actorSessionId', 'agentId']) \
            or not isinstance(selected.get('toolCallId'), str) or not 0 < units(selected['toolCallId']) <= 4096 \
            or not all(isinstance(selected.get(key), str) and re.fullmatch('[a-f0-9]{64}', selected[key])
                       for key in ['operationId', 'requestFingerprint', 'sourceHash']) \
            or selected['requestId'] != 'agent-create:' + selected['operationId'] or selected['operationId'] != intent.get('operationId') \
            or any(selected.get(key) != origin.get(other) for key, other in [('workspaceId', 'workspaceId'), ('actorUserId', 'userId'),
                       ('actorSessionId', 'piSessionId'), ('agentId', 'agentId'), ('toolName', 'toolName'), ('toolCallId', 'toolCallId')]) \
            or not isinstance(selected.get('targetPath'), str) or not 0 < units(selected['targetPath']) <= 4096 \
            or selected['targetPath'] != intent.get('targetPath') or not re.search(r'\.(?:md|markdown)$', selected['targetPath'], re.IGNORECASE) \
            or any(name in ('', '.', '..') or re.search(r'[\\\x00-\x1f\x7f]', name) for name in selected['targetPath'].split('/')) \
            or type(selected.get('sourceBytes')) is not int or not 0 <= selected['sourceBytes'] <= 8 * 1024 * 1024:
        fail('SOURCE_CHANGED')
    return dict(selected)


def current_source(intent):
    """Read the real original staging leaf, never the retained snapshot.

    The Node owner already holds the existing SessionSH/FileEX/I02 fences.
    This helper read checks eligibility/attribution, never authentication or a
    new permission. The parent repeats the FD checks after actual child close
    in its own synchronous final publication turn.
    """
    selected = intent['source']
    if 'kind' in selected:
        if selected.get('kind') == 'direct-mcp-markdown-v1':
            return direct_mcp_attribution(intent)
        if selected.get('kind') == 'agent-markdown-v1':
            return agent_attribution(intent)
        keys = {'kind', 'workspaceId', 'targetPath', 'actorUserId', 'actorSessionId', 'requestId', 'operationId', 'sourceHash', 'sourceBytes'}
        origin = intent.get('origin')
        if not isinstance(selected, dict) or set(selected) != keys or selected.get('kind') != 'manual-empty-v1' \
                or type(selected.get('sourceBytes')) is not int or selected['sourceBytes'] != 0 or selected.get('sourceHash') != digest(b'') \
                or not isinstance(origin, dict) or selected.get('workspaceId') != origin.get('workspaceId') \
                or selected.get('actorUserId') != origin.get('userId') or selected.get('actorSessionId') != origin.get('sessionId') \
                or selected.get('targetPath') != intent.get('targetPath') or selected.get('operationId') != intent.get('operationId') \
                or selected.get('requestId') != selected.get('operationId') or not isinstance(selected.get('operationId'), str) \
                or not re.fullmatch('manual-create:[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', selected['operationId']):
            fail('SOURCE_CHANGED')
        # The parent owns genuine A/D authorization. This exact protocol value
        # is merely attribution; the preparation child never links a target.
        return dict(selected)
    session_id, file_id = selected['uploadSessionId'], selected['fileId']
    if not all(isinstance(value, str) and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value) for value in [session_id, file_id]):
        fail('SOURCE_CHANGED')
    opened = []
    try:
        uploads = open_dir(3, '.uploads')
        opened.append(uploads)
        workspace = open_dir(uploads, 'workspace', True)
        opened.append(workspace)
        session = open_dir(workspace, session_id, True)
        opened.append(session)
        raw, manifest_profile = read_file(session, 'session.json', 16 * 1024 * 1024)
        manifest = decode(raw)
        if not isinstance(manifest, dict) or manifest.get('id') != session_id or manifest.get('userId') != selected['actorUserId'] \
                or manifest.get('workspaceId') != selected['workspaceId'] or manifest.get('status') != 'receiving':
            fail('SOURCE_CHANGED')
        expires = manifest.get('expiresAt')
        if not isinstance(expires, str) or len(expires) > 64:
            fail('SOURCE_CHANGED')
        deadline = datetime.datetime.fromisoformat(expires.replace('Z', '+00:00'))
        if deadline.tzinfo is None:
            fail('SOURCE_CHANGED')
        files = manifest.get('files')
        if not isinstance(files, list) or not 1 <= len(files) <= 1000:
            fail('SOURCE_CHANGED')
        matches = [value for value in files if isinstance(value, dict) and value.get('id') == file_id]
        if len(matches) != 1:
            fail('SOURCE_CHANGED')
        file = matches[0]
        if 'officeAttempt' in file or file.get('targetPath') != selected['targetPath'] or type(file.get('size')) is not int \
                or file['size'] != selected['sourceBytes']:
            fail('SOURCE_CHANGED')
        try:
            progress_raw, progress_profile = read_file(session, file_id + '.part.json')
            progress = decode(progress_raw)
        except FileNotFoundError:
            progress, progress_profile = file, None
        if not isinstance(progress, dict) or progress.get('status') not in (['pending', 'uploaded'] if file['size'] == 0 else ['uploaded']) \
                or type(progress.get('uploadedBytes')) is not int or progress['uploadedBytes'] != file['size']:
            fail('SOURCE_CHANGED')
        source, source_profile = read_file(session, file_id + '.part', LIMIT)
        if len(source) != selected['sourceBytes'] or digest(source) != selected['sourceHash']:
            fail('SOURCE_CHANGED')
        if progress_profile is not None and read_file(session, file_id + '.part.json')[1] != progress_profile \
                or read_file(session, 'session.json', 16 * 1024 * 1024)[1] != manifest_profile:
            fail('SOURCE_CHANGED')
        named(3, '.uploads', uploads)
        named(uploads, 'workspace', workspace)
        named(workspace, session_id, session)
        result = {'directories': [directory(fd) for fd in opened], 'manifestInode': {key: manifest_profile[key] for key in ['dev', 'ino', 'uid', 'mode']},
                  'header': {key: manifest.get(key) for key in ['id', 'userId', 'workspaceId', 'targetDir', 'createdAt', 'expiresAt']},
                  'selected': {key: file.get(key) for key in ['id', 'sourceIndex', 'relativePath', 'targetPath', 'size', 'mimeType']},
                  'part': source_profile, 'progress': progress_profile}
        if datetime.datetime.now(datetime.timezone.utc) >= deadline:
            fail('SOURCE_EXPIRED')
        return result
    finally:
        for fd in reversed(opened):
            os.close(fd)


def run(message):
    if set(message) - {'action', 'intent', 'key', 'bytes', 'serializedHash', 'revisionId'} or message.get('action') not in ('open', 'verify', 'prepare', 'observe', 'complete'):
        fail('INVALID_INPUT')
    intent, key = message['intent'], message['key']
    if not isinstance(intent, dict) or not re.fullmatch('[a-f0-9]{64}', key):
        fail('INVALID_INPUT')
    root = intent['workspaceRoot']
    if directory(3) != intent['dataRoot'] or directory(4) != root:
        fail('NAMESPACE_CHANGED')
    target = intent['targetPath']
    if not isinstance(target, str) or len(target) > 4096 or any(part in ('', '.', '..') for part in target.split('/')) or re.search(r'[\\\x00-\x1f\x7f]', target):
        fail('INVALID_INPUT')
    if not isinstance(intent.get('source'), dict):
        fail('SOURCE_CHANGED')
    if 'kind' in intent['source']:
        # Fixed source kinds are attribution, not upload manifests or grants.
        # Validate them before even initializing the private claim namespace.
        current_source(intent)
    file_limit = 8 * 1024 * 1024 if intent['source'].get('kind') == 'agent-markdown-v1' else LIMIT
    verification = message['action'] == 'verify'
    store_name, store = existing_claim_store(3) if verification else claim_store(3)
    claim = None
    try:
        if verification:
            created = False
        else:
            try:
                os.mkdir(key, 0o700, dir_fd=store)
                created = True
            except FileExistsError:
                created = False
        try:
            claim = open_dir(store, key, True)
        except FileNotFoundError:
            if verification:
                fail('RECORD_CHANGED')
            raise
        before = optional_record(claim, 'intent.json')
        if created:
            if message['action'] != 'open' or before is not None:
                fail('RECORD_CHANGED')
            manual_new = intent['source'].get('kind') == 'manual-empty-v1'
            if manual_new:
                current_source(intent)
            intent = {**intent, 'ancestors': capture_absence(4, target, manual_new), 'sourceAttribution': current_source(intent)}
            record(claim, 'intent.json', intent)
            os.fsync(store)
            ack('intent_durable')
        else:
            if not isinstance(before, dict) or {key: value for key, value in before.items() if key not in ['ancestors', 'sourceAttribution']} != intent:
                fail('RECORD_CHANGED')
            intent = before
        initial = intent['ancestors']
        if not isinstance(initial, dict):
            fail('RECORD_CHANGED')
        parents = {}
        for name in directory_entries(claim):
            if name.startswith('parent-') and name.endswith('.json'):
                value = optional_record(claim, name)
                if set(value) != {'path', 'identity'} or name != 'parent-' + digest(value['path'].encode()) + '.json':
                    fail('RECORD_CHANGED')
                parents[value['path']] = value['identity']
        prepared = optional_record(claim, 'prepared.json')
        born = optional_record(claim, 'born.json')
        completed = optional_record(claim, 'completed.json')
        settled = optional_record(claim, 'settled.json')
        parent, opened = parent_for(4, target, initial, parents)
        try:
            name = target.split('/')[-1]
            if parent is not None:
                try:
                    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    info = None
            else:
                info = None
            if info is not None:
                if prepared is None or not stat.S_ISREG(info.st_mode) or file_identity(info) != prepared['file']:
                    fail('TARGET_CHANGED')
                if completed is None:
                    data, observed = read_file(claim, 'content.tmp', file_limit, 2)
                    if observed != prepared['file'] or digest(data) != prepared['serializedHash'] or info.st_nlink != 2:
                        fail('TARGET_CHANGED')
                    actual, observed = read_file(parent, name, file_limit, 2)
                else:
                    links = info.st_nlink
                    if links not in (1, 2):
                        fail('TARGET_CHANGED')
                    actual, observed = read_file(parent, name, file_limit, links)
                    if links == 2:
                        temp, temp_info = read_file(claim, 'content.tmp', file_limit, 2)
                        if temp_info != observed or temp != actual:
                            fail('TARGET_CHANGED')
                    elif settled != {'file': file_identity(info), 'ctimeNs': str(info.st_ctime_ns)}:
                        # The private twin is gone. An unconfirmed unlink/record
                        # gap cannot be recovered from byte equality alone.
                        fail('RECOVERY_REQUIRED')
                if observed != prepared['file'] or digest(actual) != prepared['serializedHash']:
                    fail('TARGET_CHANGED')
            elif born is not None or completed is not None:
                fail('TARGET_CHANGED')
            if message['action'] == 'prepare':
                content = base64.b64decode(message['bytes'], validate=True)
                if len(content) > file_limit or digest(content) != message['serializedHash']:
                    fail('INVALID_INPUT')
                if intent['source'].get('kind') == 'manual-empty-v1' and content != b'':
                    fail('SOURCE_CHANGED')
                if prepared is None:
                    fd = os.open('content.tmp', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=claim)
                    try:
                        view = memoryview(content)
                        while view:
                            count = os.write(fd, view)
                            if count <= 0:
                                fail('IO_UNCONFIRMED')
                            view = view[count:]
                        # Public file mode is fixed before its inode is bound.
                        os.fchmod(fd, 0o644)
                        os.fsync(fd)
                        prepared = {'version': 1, 'file': file_identity(os.fstat(fd)), 'serializedHash': digest(content)}
                    finally:
                        os.close(fd)
                    ack('temp_synced')
                    record(claim, 'prepared.json', prepared)
                    os.fsync(claim)
                    ack('prepared_durable')
                elif prepared['serializedHash'] != digest(content):
                    fail('TARGET_CHANGED')
                if info is None:
                    staged, staged_info = read_file(claim, 'content.tmp', file_limit)
                    if staged != content or staged_info != prepared['file']:
                        fail('TARGET_CHANGED')
                    ack('before_link')
                    assert_parents(4, target, opened)
                    if current_source(intent) != intent['sourceAttribution']:
                        fail('SOURCE_CHANGED')
            if message['action'] == 'observe':
                if info is None or prepared is None:
                    fail('TARGET_CHANGED')
                ack('target_linked')
                record(claim, 'born.json', prepared)
                ack('born_durable')
                born = prepared
            if message['action'] == 'complete':
                if info is None or born != prepared or prepared is None or message['serializedHash'] != prepared['serializedHash']:
                    fail('TARGET_CHANGED')
                value = {**prepared, 'revisionId': message['revisionId']}
                record(claim, 'completed.json', value)
                completed = value
                try:
                    temp, observed = read_file(claim, 'content.tmp', file_limit, 2)
                    if observed != prepared['file'] or digest(temp) != prepared['serializedHash']:
                        fail('TARGET_CHANGED')
                    os.unlink('content.tmp', dir_fd=claim)
                    os.fsync(claim)
                    os.fsync(parent)
                    settled = {'file': file_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)),
                               'ctimeNs': str(os.stat(name, dir_fd=parent, follow_symlinks=False).st_ctime_ns)}
                    record(claim, 'settled.json', settled)
                    os.fsync(claim)
                except FileNotFoundError:
                    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if current.st_nlink != 1 or settled != {'file': file_identity(current), 'ctimeNs': str(current.st_ctime_ns)}:
                        fail('TARGET_CHANGED')
                ack('complete_durable')
            named(store, key, claim)
            named(3, store_name, store)
            assert_parents(4, target, opened)
            return {'state': 'complete' if completed else 'born' if born or info is not None else 'prepared' if prepared else 'intent',
                    'intent': intent, 'serializedHash': prepared['serializedHash'] if prepared else None,
                    'fingerprint': digest(encode(intent)), 'revisionId': completed['revisionId'] if completed else None}
        finally:
            for fd in reversed(opened):
                os.close(fd)
    finally:
        if claim is not None:
            os.close(claim)
        os.close(store)


try:
    request = sys.stdin.readline(64 * 1024 * 1024 + 1)
    if len(request) > 64 * 1024 * 1024:
        fail('INVALID_INPUT')
    message = decode(request)
    if isinstance(message.get('intent'), dict) and isinstance(message['intent'].get('source'), dict) \
            and message['intent']['source'].get('kind') == 'agent-markdown-v1':
        agent_attribution(message['intent'])
        if len(request.encode('utf-8')) > 64 * 1024 * 1024:
            fail('INVALID_INPUT')
    elif len(request) > 8 * 1024 * 1024:
        fail('INVALID_INPUT')
    print(json.dumps({'result': run(message)}), flush=True)
except BaseException as error:
    print(json.dumps({'error': str(error) if isinstance(error, Refused) else 'MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED'}), flush=True)
    sys.exit(1)
