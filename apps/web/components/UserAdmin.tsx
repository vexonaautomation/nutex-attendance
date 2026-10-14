'use client';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from './AuthProvider';
import { useAction, useFetch } from '@/hooks/useApi';
import { label } from '@/lib/format';
import { DataTable } from './DataTable';
import { Badge, Card, ErrorState, Field, Modal, PasswordInput } from './ui';
import { Icon } from './Icon';

// type aliases (not interfaces) so rows satisfy DataTable's Record<string, unknown> constraint
export type UserRow = {
  incomplete?: boolean; userId: string; employeeId: string; employeeName: string; username: string; displayName: string; role: string; locationScope: string; status: string; mustChangePassword: boolean; lastLoginAt?: string;
};
export type EmployeeLite = { employee_id: string; employee_code: string; first_name: string; last_name?: string; location_id?: string; status?: string };

const ROLES: Array<{ value: string; text: string }> = [
  { value: 'EMPLOYEE', text: 'Employee: own attendance, leave, payslips' },
  { value: 'MANAGER', text: 'Manager: team attendance and approvals' },
  { value: 'HR_ADMIN', text: 'HR admin: employees, attendance, leave, shifts for their branch' },
  { value: 'FINANCE_PAYROLL', text: 'Finance / payroll: salary, payroll, compliance' },
  { value: 'ATTENDANCE_OPERATOR', text: 'Site clerk: branch attendance and regularisations' },
  { value: 'SUPER_ADMIN', text: 'Owner / Admin: everything' },
];

/** the owner may give any role; HR only the ordinary ones (the server enforces the same) */
const HR_ROLES = new Set(['EMPLOYEE', 'MANAGER', 'ATTENDANCE_OPERATOR']);
const rolesFor = (me: { role: string } | null) => (me?.role === 'SUPER_ADMIN' ? ROLES : ROLES.filter((r) => HR_ROLES.has(r.value)));

const fullName = (e: EmployeeLite) => `${e.first_name} ${e.last_name ?? ''}`.trim();

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** shown once after a login is created or a password is set: the administrator hands these to the person */
export function CredentialsDialog({ username, password, name, forceChange, onClose }: { username: string; password: string; name: string; forceChange: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Username: ${username}\nPassword: ${password}`;
  return (
    <Modal title="Login details" onClose={onClose} small>
      <p>Give these to <b>{name}</b>. The password is shown only now and cannot be looked up later{forceChange ? '; they will be asked to choose their own at first sign-in.' : '.'}</p>
      <pre className="mono" style={{ padding: 12, background: 'var(--bg)', borderRadius: 8, userSelect: 'all', margin: '12px 0', whiteSpace: 'pre-wrap' }}>{text}</pre>
      <div className="modal-actions">
        <button className="btn" onClick={async () => setCopied(await copy(text))}>{copied ? 'Copied' : 'Copy'}</button>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

function PasswordChoice({ mode, setMode, password, setPassword }: { mode: 'generate' | 'custom'; setMode: (m: 'generate' | 'custom') => void; password: string; setPassword: (p: string) => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 16 }}>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="pwmode" checked={mode === 'generate'} onChange={() => setMode('generate')} /> Generate a password</label>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="pwmode" checked={mode === 'custom'} onChange={() => setMode('custom')} /> I will type one</label>
      </div>
      {mode === 'custom' && (
        <Field label="Password" hint="At least 8 characters with letters and digits">
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" label="Password" minLength={8} />
        </Field>
      )}
    </div>
  );
}

/** create a login (username + password) for an employee */
export function IssueLoginDialog({ employees, fixed, onClose, onDone }: { employees: EmployeeLite[]; fixed?: EmployeeLite; onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const roles = rolesFor(me);
  const [empId, setEmpId] = useState(fixed?.employee_id ?? '');
  const emp = fixed ?? employees.find((e) => e.employee_id === empId);
  const [username, setUsername] = useState<string | undefined>();
  const [displayName, setDisplayName] = useState<string | undefined>();
  const [role, setRole] = useState('EMPLOYEE');
  const [scope, setScope] = useState<string | undefined>();
  const [mode, setMode] = useState<'generate' | 'custom'>('generate');
  const [password, setPassword] = useState('');
  const [force, setForce] = useState(true);
  const [creds, setCreds] = useState<{ username: string; password: string; name: string; force: boolean } | null>(null);
  const { busy, run } = useAction();

  const effUsername = (username ?? (emp ? emp.employee_code.toLowerCase() : '')).trim();
  const effName = (displayName ?? (emp ? fullName(emp) : '')).trim();
  const effScope = (scope ?? emp?.location_id ?? '').trim();
  const ready = !!emp && effUsername.length >= 3 && effName.length >= 2 && (mode === 'generate' || password.length >= 8);

  if (creds) return <CredentialsDialog username={creds.username} password={creds.password} name={creds.name} forceChange={creds.force} onClose={() => { onDone(); onClose(); }} />;
  return (
    <Modal title={fixed ? `Create login for ${fullName(fixed)}` : 'Create login'} onClose={onClose}>
      <div className="form-grid">
        {!fixed && (
          <Field label="Employee *">
            <select value={empId} onChange={(e) => setEmpId(e.target.value)}>
              <option value="">Choose an employee</option>
              {employees.map((e) => <option key={e.employee_id} value={e.employee_id}>{e.employee_code} · {fullName(e)}</option>)}
            </select>
          </Field>
        )}
        <Field label="Username *" hint="What they type to sign in (3+ characters: letters, digits . _ - @). Change it if you like."><input value={username ?? effUsername} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} /></Field>
        <Field label="Display name *"><input value={displayName ?? effName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
        <Field label="Role *" hint={ROLES.find((r) => r.value === role)?.text}>
          <select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.value} value={r.value}>{label(r.value)}</option>)}</select>
        </Field>
        <Field label="Branch access" hint="ALL, or comma separated branch ids. Defaults to the employee's own branch."><input value={scope ?? effScope} onChange={(e) => setScope(e.target.value)} /></Field>
      </div>
      <div style={{ marginTop: 12 }}><PasswordChoice mode={mode} setMode={setMode} password={password} setPassword={setPassword} /></div>
      <label className="row" style={{ gap: 8, marginTop: 12 }}><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Ask them to choose a new password at first sign-in (recommended)</label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !ready} onClick={async () => {
          const body = { employeeId: emp!.employee_id, username: effUsername, displayName: effName, role, locationScope: effScope, forceChange: force, ...(mode === 'custom' ? { password } : {}) };
          const r = await run(() => api.post<{ temporaryPassword?: string }>('/api/users', body), 'Login created');
          if (r) setCreds({ username: effUsername, password: r.temporaryPassword ?? password, name: effName, force });
        }}>{busy ? 'Creating…' : 'Create login'}</button>
      </div>
    </Modal>
  );
}

/** set a specific password, or generate a new one */
export function PasswordDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'generate' | 'custom'>('generate');
  const [password, setPassword] = useState('');
  const [force, setForce] = useState(true);
  const [creds, setCreds] = useState<{ password: string } | null>(null);
  const { busy, run } = useAction();
  if (creds) return <CredentialsDialog username={user.username} password={creds.password} name={user.displayName} forceChange={force} onClose={() => { onDone(); onClose(); }} />;
  return (
    <Modal title={`New password for ${user.username}`} onClose={onClose}>
      <p className="muted" style={{ marginBottom: 12 }}>Their current password stops working and any signed-in session ends.</p>
      <PasswordChoice mode={mode} setMode={setMode} password={password} setPassword={setPassword} />
      <label className="row" style={{ gap: 8, marginTop: 12 }}><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Ask them to choose their own at next sign-in</label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || (mode === 'custom' && password.length < 8)} onClick={async () => {
          const body = mode === 'custom' ? { password, forceChange: force } : { resetPassword: true, forceChange: force };
          const r = await run(() => api.patch<{ temporaryPassword?: string }>(`/api/users/${user.userId}`, body), 'Password set');
          if (r) setCreds({ password: r.temporaryPassword ?? password });
        }}>{busy ? 'Saving…' : 'Set password'}</button>
      </div>
    </Modal>
  );
}

function EditUserDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const roles = rolesFor(me);
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [scope, setScope] = useState(user.locationScope);
  const { busy, run } = useAction();
  return (
    <Modal title={`Edit ${user.username}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Username"><input value={username} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} /></Field>
        <Field label="Display name"><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
        <Field label="Role" hint={ROLES.find((r) => r.value === role)?.text}><select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.value} value={r.value}>{label(r.value)}</option>)}</select></Field>
        <Field label="Branch access" hint="ALL, or comma separated branch ids"><input value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          const body: Record<string, string> = {};
          if (username !== user.username) body.username = username;
          if (displayName !== user.displayName) body.displayName = displayName;
          if (role !== user.role) body.role = role;
          if (scope !== user.locationScope) body.locationScope = scope;
          if (!Object.keys(body).length) return onClose();
          const r = await run(() => api.patch(`/api/users/${user.userId}`, body), 'Saved');
          if (r) { onDone(); onClose(); }
        }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

type Act = { kind: 'edit' | 'password'; user: UserRow };

function useUserActions(reload: () => void) {
  const [act, setAct] = useState<Act | null>(null);
  const { run } = useAction();
  const setStatus = async (u: UserRow, status: 'ACTIVE' | 'DISABLED') => {
    await run(() => api.patch(`/api/users/${u.userId}`, { status }), status === 'ACTIVE' ? 'Login enabled' : 'Login disabled');
    reload();
  };
  const dialogs = (
    <>
      {act?.kind === 'edit' && <EditUserDialog user={act.user} onClose={() => setAct(null)} onDone={reload} />}
      {act?.kind === 'password' && <PasswordDialog user={act.user} onClose={() => setAct(null)} onDone={reload} />}
    </>
  );
  return { setAct, setStatus, dialogs };
}

function UserButtons({ u, setAct, setStatus }: { u: UserRow; setAct: (a: Act) => void; setStatus: (u: UserRow, s: 'ACTIVE' | 'DISABLED') => void }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="btn sm" onClick={() => setAct({ kind: 'edit', user: u })}>Edit</button>
      <button className="btn sm" onClick={() => setAct({ kind: 'password', user: u })}><Icon name="key" size={14} /> Password</button>
      {u.status === 'ACTIVE' ? <button className="btn sm danger" onClick={() => setStatus(u, 'DISABLED')}>Disable</button> : <button className="btn sm" onClick={() => setStatus(u, 'ACTIVE')}>Enable</button>}
    </span>
  );
}

/** Settings -> Users: every login in the company */
export function UserAdmin() {
  const users = useFetch<UserRow[]>('/api/users');
  const emps = useFetch<EmployeeLite[]>('/api/r/employees');
  const [creating, setCreating] = useState(false);
  const [finish, setFinish] = useState<EmployeeLite | null>(null);
  const { setAct, setStatus, dialogs } = useUserActions(users.reload);
  const withoutLogin = useMemo(() => {
    const has = new Set((users.data ?? []).filter((u) => !u.incomplete && u.status !== 'DISABLED').map((u) => u.employeeId));
    return (emps.data ?? []).filter((e) => e.status !== 'INACTIVE' && !has.has(e.employee_id));
  }, [users.data, emps.data]);
  return (
    <Card title="Logins" actions={<button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Create login</button>}>
      <p className="muted" style={{ marginBottom: 10 }}>Give each person a username and a password so they can check in. {withoutLogin.length > 0 && <>{withoutLogin.length} active employee{withoutLogin.length === 1 ? ' has' : 's have'} no login yet.</>}</p>
      {users.error ? <ErrorState error={users.error} onRetry={users.reload} /> : (
        <DataTable<UserRow> rows={users.data} loading={users.loading} exportName="logins"
          columns={[
            { key: 'username', label: 'Username', render: (r) => (r.username ? String(r.username) : <span className="muted">(no username)</span>) }, { key: 'displayName', label: 'Name' }, { key: 'role', label: 'Role', render: (r) => label(r.role) },
            { key: 'employeeName', label: 'Employee' }, { key: 'locationScope', label: 'Branches' },
            { key: 'status', label: 'Status', render: (r) => r.incomplete ? <Badge value="Incomplete" tone="warn" /> : <><Badge value={r.status} />{r.mustChangePassword && <span className="muted" style={{ marginLeft: 6, fontSize: '0.75rem' }}>must change password</span>}</> },
            { key: 'lastLoginAt', label: 'Last sign-in', render: (r) => String(r.lastLoginAt ?? '').replace('T', ' ') || <span className="muted">never</span> },
            { key: '_a', label: '', sortable: false, render: (r) => r.incomplete
              ? <button className="btn sm primary" onClick={() => { const e = (emps.data ?? []).find((x) => x.employee_id === r.employeeId); if (e) setFinish(e); }}>Finish setup</button>
              : <UserButtons u={r} setAct={setAct} setStatus={setStatus} /> },
          ]} />
      )}
      {creating && <IssueLoginDialog employees={withoutLogin} onClose={() => setCreating(false)} onDone={users.reload} />}
      {finish && <IssueLoginDialog employees={[]} fixed={finish} onClose={() => setFinish(null)} onDone={users.reload} />}
      {dialogs}
    </Card>
  );
}

/** the "Login" card on an employee's page */
export function EmployeeLogin({ employee }: { employee: EmployeeLite }) {
  const users = useFetch<UserRow[]>('/api/users');
  const [creating, setCreating] = useState(false);
  const { setAct, setStatus, dialogs } = useUserActions(users.reload);
  if (users.error?.status === 403) return null; // only a super admin manages logins
  const mine = (users.data ?? []).filter((u) => u.employeeId === employee.employee_id);
  const complete = mine.filter((u) => !u.incomplete);
  const current = complete.find((u) => u.status !== 'DISABLED') ?? complete[0];
  const halfDone = mine.some((u) => u.incomplete);
  return (
    <Card title="Sign-in account" actions={!current || current.status === 'DISABLED' ? <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Create login</button> : undefined}>
      {users.error ? <ErrorState error={users.error} onRetry={users.reload} /> : !users.data ? <p className="muted">Loading…</p> : !current ? (
        <p className="muted">{fullName(employee)} has no working login yet, so they cannot check in.{halfDone && ' An unfinished login row exists (typed into the sheet by hand?); creating the login completes it.'} Choose a username and a password and hand both to them.</p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 12 }}><b className="mono">{current.username}</b><Badge value={current.status} /><Badge value={current.role} tone="info" />{current.mustChangePassword && <span className="muted">must change password at next sign-in</span>}</div>
          <div className="muted">Branches: {current.locationScope || '-'} · Last sign-in: {String(current.lastLoginAt ?? '').replace('T', ' ') || 'never'}</div>
          <UserButtons u={current} setAct={setAct} setStatus={setStatus} />
        </div>
      )}
      {creating && <IssueLoginDialog employees={[]} fixed={employee} onClose={() => setCreating(false)} onDone={users.reload} />}
      {dialogs}
    </Card>
  );
}
