/** Independent scope binding for the public snipara.validation.scope.v2 contract. */
import {openSync, readSync, closeSync, fstatSync, constants, realpathSync} from 'node:fs';
import {isAbsolute, resolve, posix} from 'node:path';
import {createHash} from 'node:crypto';

export function expectedSandboxScope(requestFile: string, scope: string): string {
  if (!scope || Array.from(scope).length > 256) throw new Error('Explicit bounded scope required');
  const fd=openSync(requestFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let text: string;
  try {
    if(!fstatSync(fd).isFile()) throw new Error('Request must be a regular file');
    const buffer=Buffer.alloc(65537);
    const bytes=readSync(fd,buffer,0,buffer.length,0);
    if(bytes>65536) throw new Error('Request exceeds input budget');
    text=buffer.subarray(0,bytes).toString('utf8');
  } finally { closeSync(fd); }
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid request');
  const r=raw as Record<string,unknown>;
  const known=new Set(['schema_version','workspace','argv','image','profile','cwd','timeout_seconds','cpus','memory_mb','pids','disk_mb','artifacts']);
  if(Object.keys(r).some(key=>!known.has(key))) throw new Error('Unknown request fields');
  const schema=r.schema_version === undefined ? 'snipara.sandbox.validation.v1' : r.schema_version;
  if(schema !== 'snipara.sandbox.validation.v1' || typeof r.workspace !== 'string' || !isAbsolute(r.workspace) || r.workspace.split('/').includes('..') || typeof r.image !== 'string' || !r.image || r.image.startsWith('-') || /\s/.test(r.image)) throw new Error('Unsupported request identity');
  let workspace=resolve(r.workspace);
  for(const prefix of ['/tmp','/var']) if(workspace===prefix || workspace.startsWith(prefix+'/')) { workspace=realpathSync(prefix)+workspace.slice(prefix.length);break; }
  const profile=r.profile === undefined ? 'python' : r.profile;
  const cwd=r.cwd === undefined ? '.' : r.cwd;
  if(!['python','node','mixed'].includes(String(profile)) || typeof profile !== 'string' || typeof cwd !== 'string' || !cwd || posix.isAbsolute(cwd) || /[\\:\0]/.test(cwd) || cwd.split('/').includes('..')) throw new Error('Unsupported profile or cwd');
  function integer(name: string, fallback: number, min: number, max: number): number {
    const value=r[name] === undefined ? fallback : r[name];
    if(typeof value !== 'number' || !Number.isInteger(value) || value<min || value>max) throw new Error('Invalid resource limit');
    return value;
  }
  const cpus=r.cpus === undefined ? 2 : r.cpus;
  if(typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus<0.01 || cpus>8) throw new Error('Invalid CPU limit');
  const parts=['snipara.validation.scope.v2',scope,schema,workspace,profile,r.image,posix.normalize(cwd).replace(/\/+$/,'') || '.',String(integer('timeout_seconds',120,1,900)),String(Math.trunc(cpus*1_000_000_000)),String(integer('memory_mb',2048,64,8192)),String(integer('pids',128,16,512)),String(integer('disk_mb',2048,16,4096))];
  if(parts.some(value=>Buffer.from(value,'utf8').toString('utf8')!==value)) throw new Error('Invalid Unicode identity');
  return createHash('sha256').update(JSON.stringify(parts),'utf8').digest('hex');
}
