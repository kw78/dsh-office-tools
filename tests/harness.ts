/**
 * Shared in-process tool harness: mounts the plugin on a fake Cordis context
 * whose `fs` service is a test double backed by the real temp-directory file
 * system. The double implements the exact contract the plugin relies on —
 * `resolve`/`contains` containment, `stat`, `readBytes`, and a byte-exact
 * UTF-8 `writeText` — so a non-ASCII package would fail every round-trip
 * test: the ASCII-safety invariant is enforced end-to-end here, not assumed.
 *
 * tests/ (unlike src/) may use node:fs freely — it never ships in the plugin
 * artifact.
 */

import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

interface ToolRegistryLike {
  register(definition: ToolDefinition): () => void
}

interface AgentLike {
  session: { header: { cwd: string } }
}

/** Opaque FsTarget payload: the test double keys everything by absolute path. */
interface LocalTarget {
  absolute: string
}

function targetPath(target: FsTarget): string {
  return (target as unknown as LocalTarget).absolute
}

function asTarget(absolute: string): FsTarget {
  return { absolute } as unknown as FsTarget
}

class TestFileSystem {
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const base = opts?.cwd !== undefined && opts?.cwd !== '' ? resolve(opts.cwd) : resolve('.')
    const candidate = resolve(base, path)
    try {
      return asTarget(await realpath(candidate))
    } catch {
      return asTarget(candidate)
    }
  }

  processPath(target: FsTarget): string {
    return targetPath(target)
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    return hostPath
  }

  fileUrl(target: FsTarget): string {
    return `file://${targetPath(target)}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = relative(targetPath(parent), targetPath(child))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  async stat(target: FsTarget): Promise<{ version: string; type: 'file' | 'directory' | 'other'; size?: number } | undefined> {
    try {
      const info = await stat(targetPath(target))
      return {
        version: `${info.mtimeMs}`,
        type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
        size: info.size,
      }
    } catch {
      return undefined
    }
  }

  async lstat(path: string, opts?: { cwd?: string }): Promise<unknown> {
    const base = opts?.cwd !== undefined && opts?.cwd !== '' ? resolve(opts.cwd) : resolve('.')
    try {
      const info = await stat(resolve(base, path))
      return { version: `${info.mtimeMs}`, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'symlink' }
    } catch {
      return undefined
    }
  }

  async readText(target: FsTarget): Promise<string> {
    return readFile(targetPath(target), 'utf-8')
  }

  async *streamText(target: FsTarget): AsyncIterable<string> {
    yield await this.readText(target)
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const bytes = await readFile(targetPath(target))
    if (bytes.byteLength > maxBytes) {
      throw new Error(`FS_TOO_LARGE: ${bytes.byteLength} bytes exceeds the ${maxBytes} byte cap`)
    }
    return bytes
  }

  async listDir(target: FsTarget): Promise<Array<{ name: string; target: FsTarget; info: unknown }>> {
    const entries = await readdir(targetPath(target), { withFileTypes: true })
    return Promise.all(entries.map(async entry => ({
      name: entry.name,
      target: asTarget(resolve(targetPath(target), entry.name)),
      info: await this.stat(asTarget(resolve(targetPath(target), entry.name))),
    })))
  }

  async writeText(target: FsTarget, content: string): Promise<{ operation: 'create' | 'update'; version: string }> {
    const absolute = targetPath(target)
    const existed = await this.stat(target)
    // Byte-exact UTF-8 publication — non-ASCII content re-reads as different
    // bytes, which is exactly the official channel's constraint.
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf-8')
    const after = await this.stat(asTarget(absolute))
    return { operation: existed === undefined ? 'create' : 'update', version: after?.version ?? 'unknown' }
  }

  async editText(): Promise<never> {
    throw new Error('TestFileSystem does not implement editText; the office tools never call it')
  }
}

export function testFileSystem(): FileSystem {
  return new TestFileSystem() as unknown as FileSystem
}

export function execFor(root: string): ToolRunContext {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: root } } } as AgentLike,
    callId: 'test-call',
    name: 'test',
    arguments: {},
  } as unknown as ToolRunContext
}

export function mountTools(config?: { enablePptTools?: boolean }): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const context = {
    fs: testFileSystem(),
    tools: {
      register(definition: ToolDefinition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    } as ToolRegistryLike,
    effect(setup: () => () => void) {
      return setup()
    },
  } as unknown as Context
  apply(context, config)
  return tools
}

export async function run(tools: Map<string, ToolDefinition>, name: string, args: Record<string, unknown>, root: string) {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} should be registered`)
  const exec = execFor(root)
  const invoke = tool.execute.bind(tool)
  return invoke(args, exec)
}
