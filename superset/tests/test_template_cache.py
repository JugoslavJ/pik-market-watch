import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from jinja2 import DebugUndefined
from jinja2.sandbox import SandboxedEnvironment
from sqlalchemy.dialects import postgresql
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from template_cache import CachedPostgresTemplateProcessor, MemoryBytecodeCache


class TemplateCacheTests(unittest.TestCase):
    def test_bytecode_reuse_keeps_request_environments_and_contexts_separate(self):
        app = Flask(__name__)
        app.config['JINJA_CONTEXT_ADDONS'] = {}
        context = app.app_context()
        context.push()
        self.addCleanup(context.pop)
        database = SimpleNamespace(get_dialect=lambda: postgresql.dialect())
        first = CachedPostgresTemplateProcessor(database=database)
        second = CachedPostgresTemplateProcessor(database=database)
        sql = "SELECT {{ selection | where_in }}"
        self.assertEqual(first.env.from_string(sql).render(selection=["O'Brien"]), "SELECT ('O''Brien')")
        self.assertEqual(second.env.from_string(sql).render(selection=['rent']), "SELECT ('rent')")
        self.assertIsNot(first.env, second.env)
        self.assertIsInstance(first.env, SandboxedEnvironment)
        self.assertIs(first.env.undefined, DebugUndefined)

    def test_bytecode_storage_is_bounded(self):
        from jinja2 import DictLoader
        cache = MemoryBytecodeCache(limit=2)
        for index in range(3):
            env = SandboxedEnvironment(loader=DictLoader({str(index): str(index)}), bytecode_cache=cache)
            self.assertEqual(env.get_template(str(index)).render(), str(index))
        self.assertEqual(len(cache.entries), 2)


if __name__ == '__main__':
    unittest.main()
