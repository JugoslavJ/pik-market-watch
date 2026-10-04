"""Cache PostgreSQL Jinja bytecode, with a separate sandbox/context per request."""

import hashlib
from collections import OrderedDict
from threading import RLock

from jinja2 import BytecodeCache, DictLoader
from superset.jinja_context import JinjaTemplateProcessor


class MemoryBytecodeCache(BytecodeCache):
    def __init__(self, limit=256):
        self.limit = limit
        self.entries = OrderedDict()
        self.lock = RLock()

    def load_bytecode(self, bucket):
        with self.lock:
            content = self.entries.get(bucket.key)
            if content is not None:
                self.entries.move_to_end(bucket.key)
                bucket.bytecode_from_string(content)

    def dump_bytecode(self, bucket):
        with self.lock:
            self.entries[bucket.key] = bucket.bytecode_to_string()
            self.entries.move_to_end(bucket.key)
            while len(self.entries) > self.limit:
                self.entries.popitem(last=False)


bytecode_cache = MemoryBytecodeCache()


class CachedPostgresTemplateProcessor(JinjaTemplateProcessor):
    engine = "postgresql"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.env.bytecode_cache = bytecode_cache
        self.env.loader = DictLoader({})
        original = self.env.from_string

        def from_string(source, globals=None, template_class=None):
            if not isinstance(source, str) or template_class is not None:
                return original(source, globals=globals, template_class=template_class)
            name = hashlib.sha256(source.encode()).hexdigest()
            self.env.loader.mapping[name] = source
            return self.env.get_template(name, globals=globals)

        self.env.from_string = from_string
