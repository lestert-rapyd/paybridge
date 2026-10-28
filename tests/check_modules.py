#!/usr/bin/env python3
"""
check_modules.py — a no-Node static check of the ES-module graph.

There is no build step and (on some machines) no Node, so a typo'd import
or a renamed export only shows up as a blank page in the browser or a 500
from a Vercel function. This script reads every module in the frontend
(paybridge/js, paybridge/tests, inline <script type="module"> blocks) and
the backend (rapyd-backend/api, utils, server.js, tests) and reports:

  (a) imports of names the target module does not export
  (b) relative imports whose target file does not exist
  (c) namespace imports (import * as x) where x.<name> is used but <name>
      is not exported (best effort: regex on x.<name>)
  (d) duplicate top-level export names
  plus, because they are the same class of load-time SyntaxError:
  (e) `export { a }` where `a` is not declared/imported in the module
  (f) duplicate top-level bindings (two imports of `esc`, import + const …)
  (g) bare specifiers: in the browser (no import map) they always fail; in
      the backend they must be a Node builtin or a package.json dependency
  (w) WARN: calls to a name another module exports, with no import or
      declaration in this file (likely a missing import → ReferenceError)

It is a scanner, not a parser: comments are stripped and string/template
contents masked (offsets preserved) so code samples inside strings are not
mistaken for imports. Exit status is 1 if any error (not warning) is found.

Usage:  python3 tests/check_modules.py [--quiet]
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.normpath(os.path.join(HERE, '..'))
BACKEND = os.path.normpath(os.path.join(FRONTEND, '..', 'rapyd-backend'))

NODE_BUILTINS = {
    'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
    'console', 'crypto', 'dns', 'events', 'fs', 'fs/promises', 'http', 'http2',
    'https', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring',
    'readline', 'stream', 'stream/promises', 'string_decoder', 'test', 'timers',
    'timers/promises', 'tls', 'url', 'util', 'worker_threads', 'zlib',
}

IDENT = r'[A-Za-z_$][\w$]*'
KEYWORDS_BEFORE_REGEX = {
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await',
}


# ── Lexing: strip comments, mask string contents (length-preserving) ──

def lex(src):
    """Return (code, masked). `code` has comments blanked; `masked` also has
    the *contents* of string/template/regex literals blanked (quotes kept), so
    regexes over `masked` only ever see real code. Newlines are preserved in
    both so offsets and line numbers line up with the original."""
    n = len(src)
    code = list(src)
    masked = list(src)
    i = 0
    tmpl_stack = []   # brace depth at which each open `${` started
    brace = 0
    last_sig = ''     # last significant (non-space) token char/word, for regex detection

    def blank(buf, a, b):
        for k in range(a, b):
            if buf[k] != '\n':
                buf[k] = ' '

    def scan_template(j):
        """j points just after a backtick or a closing `}` of `${…}`.
        Returns (end_index, opened_expr) — end is after the closing backtick
        or after the `${`."""
        while j < n:
            c = src[j]
            if c == '\\':
                j += 2
                continue
            if c == '`':
                return j + 1, False
            if c == '$' and j + 1 < n and src[j + 1] == '{':
                return j + 2, True
            j += 1
        return n, False

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            j = src.find('\n', i)
            j = n if j == -1 else j
            blank(code, i, j); blank(masked, i, j)
            i = j
            continue
        if c == '/' and nxt == '*':
            j = src.find('*/', i + 2)
            j = n if j == -1 else j + 2
            blank(code, i, j); blank(masked, i, j)
            i = j
            continue
        if c in ('"', "'"):
            j = i + 1
            while j < n and src[j] != c and src[j] != '\n':
                j += 2 if src[j] == '\\' else 1
            blank(masked, i + 1, j)
            i = j + 1
            last_sig = 'str'
            continue
        if c == '`':
            j, opened = scan_template(i + 1)
            blank(masked, i + 1, j - (2 if opened else 1))
            if opened:
                tmpl_stack.append(brace)
                brace += 1
                last_sig = '{'
            else:
                last_sig = 'str'
            i = j
            continue
        if c == '}' and tmpl_stack and brace - 1 == tmpl_stack[-1]:
            # end of a `${…}` expression — resume the template literal
            tmpl_stack.pop()
            brace -= 1
            j, opened = scan_template(i + 1)
            blank(masked, i + 1, j - (2 if opened else 1))
            if opened:
                tmpl_stack.append(brace)
                brace += 1
                last_sig = '{'
            else:
                last_sig = 'str'
            i = j
            continue
        if c == '/':
            regex_ok = (last_sig == '' or last_sig in '(,=:[!&|?{};+-*%<>~^'
                        or last_sig in KEYWORDS_BEFORE_REGEX)
            if regex_ok:
                j = i + 1
                in_class = False
                while j < n and src[j] != '\n':
                    if src[j] == '\\':
                        j += 2
                        continue
                    if src[j] == '[':
                        in_class = True
                    elif src[j] == ']':
                        in_class = False
                    elif src[j] == '/' and not in_class:
                        break
                    j += 1
                blank(masked, i + 1, j)
                i = j + 1
                while i < n and (src[i].isalpha()):  # flags
                    i += 1
                last_sig = 'str'
                continue
        if c == '{':
            brace += 1
        elif c == '}':
            brace -= 1
        if c.isspace():
            i += 1
            continue
        m = re.match(r'[A-Za-z_$][\w$]*', src[i:i + 64])
        if m:
            last_sig = m.group(0)
            i += len(m.group(0))
            continue
        if c.isdigit():
            m = re.match(r'[\w.]+', src[i:i + 64])
            last_sig = 'num'
            i += len(m.group(0))
            continue
        last_sig = c
        i += 1
    return ''.join(code), ''.join(masked)


def depth_map(masked):
    """Bracket depth ({, (, [) at every offset of the masked source."""
    d = 0
    out = [0] * (len(masked) + 1)
    for i, c in enumerate(masked):
        if c in '{([':
            out[i] = d
            d += 1
        elif c in '})]':
            d -= 1
            out[i] = d
        else:
            out[i] = d
    out[len(masked)] = d
    return out


def line_of(src, offset):
    return src.count('\n', 0, offset) + 1


# ── Module model ──

class Module:
    def __init__(self, path, src, label=None, base_dir=None, repo=None):
        self.path = path
        self.label = label or path
        self.base_dir = base_dir or os.path.dirname(path)
        self.repo = repo
        self.src = src
        self.code, self.masked = lex(src)
        self.depth = depth_map(self.masked)
        self.imports = []          # dicts: spec, line, names[(imported, local)], ns, default, side, dynamic
        self.exports = {}          # name -> line (explicit, incl. re-exports)
        self.dup_exports = []      # (name, line)
        self.local_export_refs = []  # (local, line) from `export { local as x }` without `from`
        self.reexports = []        # (spec, [(imported, exported)], line)
        self.star_exports = []     # (spec, line)
        self.bindings = {}         # top-level binding name -> (kind, line)
        self.dup_bindings = []     # (name, kind_a, kind_b, line)
        self.parse()

    # Helpers -------------------------------------------------------------
    def at_top(self, i):
        return self.depth[i] == 0

    def spec_at(self, i):
        """Read the string literal starting at offset i (quote char) from the
        original source."""
        q = self.src[i]
        j = self.src.find(q, i + 1)
        return self.src[i + 1:j], j + 1

    def add_binding(self, name, kind, line):
        prev = self.bindings.get(name)
        if prev is None:
            self.bindings[name] = (kind, line)
            return
        if prev[0] == 'var' and kind == 'var':
            return
        self.dup_bindings.append((name, prev[0], kind, line))

    def add_export(self, name, line):
        if name in self.exports:
            self.dup_exports.append((name, line))
        else:
            self.exports[name] = line

    def statement_end(self, i):
        """Offset of the end of the statement starting at i: the first `;` at
        the same depth, or a newline followed by a top-level keyword."""
        base = self.depth[i]
        n = len(self.masked)
        j = i
        while j < n:
            c = self.masked[j]
            if c == ';' and self.depth[j] == base:
                return j
            if c == '\n' and self.depth[j] == base:
                rest = self.masked[j + 1:j + 40]
                if re.match(r'\s*(export|import|const|let|var|function|async\s+function|class)\b', rest) \
                        and self.depth[j + 1] == base:
                    return j
            if self.depth[j] < base:
                return j
            j += 1
        return n

    def pattern_names(self, text):
        """Binding names in a destructuring pattern like `{ a, b: c, ...d }`
        or `[a, , b = 1]` (best effort, one nesting level)."""
        names = []
        inner = text.strip()[1:-1]
        for part in split_top(inner):
            part = part.strip()
            if not part:
                continue
            part = part.lstrip('.').strip()
            part = part.split('=', 1)[0].strip()
            if ':' in part:
                part = part.split(':', 1)[1].strip()
            if part[:1] in '{[':
                names.extend(self.pattern_names(part))
            elif re.fullmatch(IDENT, part):
                names.append(part)
        return names

    def declarators(self, start, end):
        """Names declared by `const|let|var <declarators>` in masked[start:end]."""
        names = []
        seg = self.masked[start:end]
        segdepth = self.depth[start:end]
        base = self.depth[start]
        # split on commas at the base depth
        parts, cur, cstart = [], [], 0
        for k, ch in enumerate(seg):
            if ch == ',' and segdepth[k] == base:
                parts.append((cstart, ''.join(cur)))
                cur, cstart = [], k + 1
            else:
                cur.append(ch)
        parts.append((cstart, ''.join(cur)))
        for _off, p in parts:
            p = p.strip()
            if not p:
                continue
            if p[0] in '{[':
                # find the matching close bracket for the pattern
                close = matching(p, 0)
                names.extend(self.pattern_names(p[:close + 1]))
            else:
                m = re.match(IDENT, p)
                if m:
                    names.append(m.group(0))
        return names

    # Parsing -------------------------------------------------------------
    def parse(self):
        M = self.masked
        for m in re.finditer(r'(?<![\w$.])import\b', M):
            i = m.start()
            rest_start = m.end()
            after = M[rest_start:rest_start + 200].lstrip()
            ws = len(M[rest_start:rest_start + 200]) - len(after)
            if after.startswith('('):
                self.parse_dynamic_import(i, rest_start + ws)
                continue
            if after.startswith('.'):  # import.meta
                continue
            if not self.at_top(i):
                continue
            self.parse_static_import(i, rest_start + ws)
        for m in re.finditer(r'(?<![\w$.])export\b', M):
            if self.at_top(m.start()):
                self.parse_export(m.start(), m.end())
        self.collect_declarations()

    def parse_static_import(self, i, j):
        M, line = self.masked, line_of(self.src, i)
        if M[j] in '\'"':
            spec, _ = self.spec_at(j)
            self.imports.append(dict(spec=spec, line=line, names=[], ns=None,
                                     side=True, dynamic=False))
            return
        fm = re.compile(r'\bfrom\s*([\'"])').search(M, j)
        if not fm:
            return
        clause = M[j:fm.start()].strip()
        spec, _ = self.spec_at(fm.start(1))
        names, ns = [], None
        # default binding first
        dm = re.match(r'(' + IDENT + r')\s*(,|$)', clause)
        if dm and not clause.startswith('{') and not clause.startswith('*'):
            names.append(('default', dm.group(1)))
            clause = clause[dm.end():].strip()
        nm = re.match(r'\*\s*as\s+(' + IDENT + r')', clause)
        if nm:
            ns = nm.group(1)
            self.add_binding(ns, 'import', line)
        bm = re.search(r'\{([\s\S]*?)\}', clause)
        if bm:
            for part in bm.group(1).split(','):
                part = part.strip()
                if not part:
                    continue
                am = re.fullmatch(r'(' + IDENT + r')\s+as\s+(' + IDENT + r')', part)
                if am:
                    names.append((am.group(1), am.group(2)))
                elif re.fullmatch(IDENT, part):
                    names.append((part, part))
        for _imp, local in names:
            self.add_binding(local, 'import', line)
        self.imports.append(dict(spec=spec, line=line, names=names, ns=ns,
                                 side=False, dynamic=False))

    def parse_dynamic_import(self, i, j):
        """`import('…')` — check the file exists; if destructured directly
        (`const { a } = await import('…')`), check those names too."""
        sm = re.match(r'\(\s*([\'"])', self.masked[j:])
        if not sm:
            return  # computed specifier — can't check
        spec, _ = self.spec_at(j + sm.start(1))
        names = []
        before = self.masked[max(0, i - 200):i]
        dm = re.search(r'\{([^{}]*)\}\s*=\s*(?:await\s+)?$', before)
        if dm:
            for part in dm.group(1).split(','):
                part = part.strip()
                if not part:
                    continue
                if ':' in part:
                    imp, local = [s.strip() for s in part.split(':', 1)]
                else:
                    imp = local = part
                if re.fullmatch(IDENT, imp):
                    names.append((imp, local))
        self.imports.append(dict(spec=spec, line=line_of(self.src, i), names=names,
                                 ns=None, side=False, dynamic=True))

    def parse_export(self, i, j):
        M, line = self.masked, line_of(self.src, i)
        rest = M[j:j + 300]
        s = rest.lstrip()
        k = j + (len(rest) - len(s))
        m = re.match(r'default\b', s)
        if m:
            self.add_export('default', line)
            # `export default function name` / `class name` also bind `name`
            dm = re.match(r'default\s+(?:async\s+)?(?:function\s*\*?|class)\s+(' + IDENT + r')', s)
            if dm:
                self.add_binding(dm.group(1), 'function' if 'function' in s[:dm.end()] else 'class', line)
            return
        m = re.match(r'(?:async\s+)?function\s*\*?\s*(' + IDENT + r')', s)
        if m:
            self.add_export(m.group(1), line)
            return  # binding collected by collect_declarations
        m = re.match(r'class\s+(' + IDENT + r')', s)
        if m:
            self.add_export(m.group(1), line)
            return
        m = re.match(r'(const|let|var)\s+', s)
        if m:
            start = k + m.end()
            end = self.statement_end(start)
            for name in self.declarators(start, end):
                self.add_export(name, line)
            return
        m = re.match(r'\*\s*as\s+(' + IDENT + r')\s*from\s*([\'"])', s)
        if m:
            spec, _ = self.spec_at(k + m.start(2))
            self.add_export(m.group(1), line)
            self.reexports.append((spec, [], line))  # existence check only
            return
        m = re.match(r'\*\s*from\s*([\'"])', s)
        if m:
            spec, _ = self.spec_at(k + m.start(1))
            self.star_exports.append((spec, line))
            return
        m = re.match(r'\{([\s\S]*?)\}\s*(from\s*([\'"]))?', s)
        if m:
            pairs = []
            for part in m.group(1).split(','):
                part = part.strip()
                if not part:
                    continue
                am = re.fullmatch(r'(' + IDENT + r')\s+as\s+(' + IDENT + r')', part)
                if am:
                    pairs.append((am.group(1), am.group(2)))
                elif re.fullmatch(IDENT, part):
                    pairs.append((part, part))
            for _local, exported in pairs:
                self.add_export(exported, line)
            if m.group(2):
                spec, _ = self.spec_at(k + m.start(3))
                self.reexports.append((spec, pairs, line))
            else:
                for local, _exported in pairs:
                    self.local_export_refs.append((local, line))

    def collect_declarations(self):
        """Top-level function/class/const/let/var bindings."""
        M = self.masked
        for m in re.finditer(r'(?<![\w$.])(?:async\s+)?function\s*\*?\s*(' + IDENT + r')', M):
            if self.at_top(m.start()):
                # skip `export default function name` (already bound) and
                # function *expressions* (`= function name`, `(function name`)
                before = M[max(0, m.start() - 20):m.start()].rstrip()
                if before.endswith('default') or (before and before[-1] in '=(,:?!&|'):
                    continue
                self.add_binding(m.group(1), 'function', line_of(self.src, m.start()))
        for m in re.finditer(r'(?<![\w$.])class\s+(' + IDENT + r')', M):
            if self.at_top(m.start()):
                before = M[max(0, m.start() - 20):m.start()].rstrip()
                if before.endswith('default') or (before and before[-1] in '=(,:?!&|'):
                    continue
                self.add_binding(m.group(1), 'class', line_of(self.src, m.start()))
        for m in re.finditer(r'(?<![\w$.])(const|let|var)\s+(?=[\w$\[{])', M):
            if not self.at_top(m.start()):
                continue
            start = m.end()
            end = self.statement_end(start)
            for name in self.declarators(start, end):
                self.add_binding(name, m.group(1), line_of(self.src, m.start()))


def matching(text, i):
    pairs = {'{': '}', '[': ']', '(': ')'}
    stack = []
    for k in range(i, len(text)):
        c = text[k]
        if c in pairs:
            stack.append(pairs[c])
        elif stack and c == stack[-1]:
            stack.pop()
            if not stack:
                return k
    return len(text) - 1


def split_top(text):
    parts, depth, cur = [], 0, []
    for c in text:
        if c in '{[(':
            depth += 1
        elif c in '}])':
            depth -= 1
        if c == ',' and depth == 0:
            parts.append(''.join(cur))
            cur = []
        else:
            cur.append(c)
    parts.append(''.join(cur))
    return parts


# ── Discovery ──

def js_files():
    out = []
    for root in (os.path.join(FRONTEND, 'js'), os.path.join(FRONTEND, 'tests')):
        for dp, _dn, fns in os.walk(root):
            out += [(os.path.join(dp, f), 'frontend') for f in fns if f.endswith('.js')]
    for sub in ('api', 'utils', 'tests'):
        for dp, _dn, fns in os.walk(os.path.join(BACKEND, sub)):
            out += [(os.path.join(dp, f), 'backend') for f in fns if f.endswith('.js')]
    if os.path.exists(os.path.join(BACKEND, 'server.js')):
        out.append((os.path.join(BACKEND, 'server.js'), 'backend'))
    return sorted(out)


def html_modules():
    """Inline <script type="module"> blocks and <script type="module" src>."""
    mods, srcs = [], []
    for dp, dn, fns in os.walk(FRONTEND):
        dn[:] = [d for d in dn if d not in ('node_modules', '.git')]
        for f in fns:
            if not f.endswith('.html'):
                continue
            p = os.path.join(dp, f)
            with open(p, encoding='utf-8') as fh:
                html = fh.read()
            for m in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script>', html, re.I):
                attrs, body = m.group(1), m.group(2)
                if not re.search(r'type\s*=\s*["\']module["\']', attrs):
                    continue
                sm = re.search(r'\bsrc\s*=\s*["\']([^"\']+)["\']', attrs)
                line = html.count('\n', 0, m.start()) + 1
                if sm:
                    srcs.append((p, line, sm.group(1)))
                elif body.strip():
                    # pad with newlines so reported lines match the .html
                    pad = '\n' * html.count('\n', 0, m.start(2))
                    mods.append(Module(p, pad + body, label=f'{p} <script type=module>',
                                       base_dir=dp, repo='frontend'))
    return mods, srcs


# ── Checks ──

def rel(p):
    return os.path.relpath(p, os.path.dirname(FRONTEND))


def main():
    quiet = '--quiet' in sys.argv
    errors, warnings = [], []

    def err(mod, line, cat, msg):
        errors.append(f'{rel(mod.path)}:{line}: [{cat}] {msg}')

    def warn(mod, line, cat, msg):
        warnings.append(f'{rel(mod.path)}:{line}: [{cat}] {msg}')

    modules = {}
    for path, repo in js_files():
        with open(path, encoding='utf-8') as fh:
            modules[os.path.normpath(path)] = Module(path, fh.read(), repo=repo)
    inline, html_srcs = html_modules()
    checked = list(modules.values()) + inline

    try:
        with open(os.path.join(BACKEND, 'package.json'), encoding='utf-8') as fh:
            pkg = json.load(fh)
        backend_deps = set(pkg.get('dependencies', {})) | set(pkg.get('devDependencies', {}))
    except (OSError, ValueError):
        backend_deps = set()

    def load(path):
        path = os.path.normpath(path)
        if path not in modules and os.path.isfile(path):
            with open(path, encoding='utf-8') as fh:
                modules[path] = Module(path, fh.read())
        return modules.get(path)

    def resolve(mod, spec):
        """Return (kind, path): kind is 'rel' | 'bare' | 'url'."""
        if re.match(r'^(https?:)?//', spec):
            return 'url', None
        if spec.startswith('./') or spec.startswith('../'):
            return 'rel', os.path.normpath(os.path.join(mod.base_dir, spec))
        if spec.startswith('/'):
            root = FRONTEND if mod.repo == 'frontend' else BACKEND
            return 'rel', os.path.normpath(os.path.join(root, spec.lstrip('/')))
        return 'bare', None

    star_cache = {}

    def export_set(mod, seen=None):
        """All names `mod` exports, following `export * from` (which never
        re-exports `default`; names reachable via two different stars are
        ambiguous and therefore *not* exported)."""
        if mod.path in star_cache:
            return star_cache[mod.path]
        seen = seen or set()
        if mod.path in seen:
            return set(mod.exports)
        seen = seen | {mod.path}
        names = set(mod.exports)
        origin = {}
        ambiguous = set()
        for spec, _line in mod.star_exports:
            kind, p = resolve(mod, spec)
            target = load(p) if kind == 'rel' else None
            if not target:
                continue
            for name in export_set(target, seen) - {'default'}:
                if name in names:
                    continue
                if name in origin and origin[name] != target.path:
                    ambiguous.add(name)
                origin.setdefault(name, target.path)
        names |= set(origin) - ambiguous
        star_cache[mod.path] = names
        return names

    # Exported names across each repo — used by the missing-import heuristic.
    exported_by = {}
    for mod in modules.values():
        for name in mod.exports:
            if name != 'default':
                exported_by.setdefault((mod.repo, name), set()).add(mod.path)

    for mod in checked:
        # (d) duplicate export names
        for name, line in mod.dup_exports:
            err(mod, line, 'd', f"duplicate export '{name}' (first at line {mod.exports[name]})")
        # (f) duplicate top-level bindings
        for name, a, b, line in mod.dup_bindings:
            err(mod, line, 'f', f"'{name}' declared twice at top level ({a} then {b}, first at line {mod.bindings[name][1]})")
        # (e) export { a } of an undeclared local
        for local, line in mod.local_export_refs:
            if local not in mod.bindings:
                err(mod, line, 'e', f"export {{ {local} }} but '{local}' is not declared or imported in this module")

        specs = [(imp['spec'], imp['line'], imp) for imp in mod.imports]
        specs += [(spec, line, {'names': [(a, b) for a, b in pairs], 'ns': None,
                                'side': False, 'dynamic': False, 'reexport': True})
                  for spec, pairs, line in mod.reexports]
        specs += [(spec, line, {'names': [], 'ns': None, 'side': True, 'dynamic': False})
                  for spec, line in mod.star_exports]

        for spec, line, imp in specs:
            kind, path = resolve(mod, spec)
            if kind == 'url':
                continue
            if kind == 'bare':
                base = spec[5:] if spec.startswith('node:') else spec
                if mod.repo == 'frontend':
                    err(mod, line, 'g', f"bare specifier '{spec}' — browsers can't resolve it without an import map")
                elif spec.startswith('node:') or base in NODE_BUILTINS:
                    pass
                else:
                    pkg_name = '/'.join(spec.split('/')[:2]) if spec.startswith('@') else spec.split('/')[0]
                    if pkg_name not in backend_deps:
                        err(mod, line, 'g', f"package '{pkg_name}' is not in rapyd-backend/package.json dependencies")
                continue
            target = load(path)
            if not target:
                hint = ''
                if os.path.isfile(path + '.js'):
                    hint = f" (did you mean '{spec}.js'? ESM needs the extension)"
                elif os.path.isfile(os.path.join(path, 'index.js')):
                    hint = f" (did you mean '{spec}/index.js'?)"
                err(mod, line, 'b', f"import target '{spec}' not found{hint}")
                continue
            have = export_set(target)
            for imported, _local in imp['names']:
                if imported not in have:
                    what = 'default export' if imported == 'default' else f"'{imported}'"
                    err(mod, line, 'a', f"'{spec}' has no {what}")
            ns = imp.get('ns')
            if ns:
                for um in re.finditer(r'(?<![\w$.])' + re.escape(ns) + r'\s*\.\s*(' + IDENT + r')', mod.masked):
                    name = um.group(1)
                    if name not in have:
                        err(mod, line_of(mod.src, um.start()), 'c',
                            f"{ns}.{name} — '{spec}' does not export '{name}'")

        # (w) a call to another module's export with no import/declaration here
        declared = set(mod.bindings)
        for um in re.finditer(r'(?<![\w$.])(' + IDENT + r')\s*\(', mod.masked):
            name = um.group(1)
            if name in declared or (mod.repo, name) not in exported_by:
                continue
            if mod.path in exported_by[(mod.repo, name)]:
                continue
            # ever a param/local/shorthand, or a nested `function name`? skip
            if not only_calls(mod.masked, name) or \
                    re.search(r'\bfunction\s*\*?\s*' + re.escape(name) + r'\b', mod.masked):
                continue
            close = matching(mod.masked, um.end() - 1)
            if re.match(r'\s*\{', mod.masked[close + 1:close + 20]):
                continue  # method definition `name(…) {`
            warn(mod, line_of(mod.src, um.start()), 'w',
                 f"calls {name}() but neither imports nor declares it "
                 f"(exported by {', '.join(rel(p) for p in sorted(exported_by[(mod.repo, name)]))})")
            declared.add(name)  # one warning per name

    # <script type="module" src="…"> targets
    for html_path, line, src in html_srcs:
        if re.match(r'^(https?:)?//', src):
            continue
        base = FRONTEND if src.startswith('/') else os.path.dirname(html_path)
        target = os.path.normpath(os.path.join(base, src.lstrip('/')))
        if not os.path.isfile(target):
            errors.append(f'{rel(html_path)}:{line}: [b] <script type=module src="{src}"> not found')

    n_imports = sum(len(m.imports) for m in checked)
    print(f'check_modules: {len(checked)} modules, {n_imports} import statements scanned')
    if not quiet:
        for w in warnings:
            print('WARN  ' + w)
    for e in errors:
        print('ERROR ' + e)
    if errors:
        print(f'FAIL — {len(errors)} error(s), {len(warnings)} warning(s)')
        return 1
    print(f'OK — 0 errors, {len(warnings)} warning(s)')
    return 0


def only_calls(masked, name):
    """True if every bare occurrence of `name` is a call `name(` (i.e. it is
    never declared as a param/local/property here)."""
    for m in re.finditer(r'(?<![\w$.])' + re.escape(name) + r'(?![\w$])', masked):
        tail = masked[m.end():m.end() + 10].lstrip()
        if not tail.startswith('('):
            return False
    return True


if __name__ == '__main__':
    sys.exit(main())
