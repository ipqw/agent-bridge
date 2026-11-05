import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, events, type Approval, type Config, type EditRecord, type JournalEntry, type ReplaceResult, type State, type ToolMode } from "./api";

// Main screen is what the user does every day: approve, manage folders, look at the journal.
// One-time setup and diagnostics live under «Настройка», each block collapsed.
type Tab = "folders" | "apps" | "journal" | "settings";

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [tab, setTab] = useState<Tab>("folders");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api<State>("GET", "/api/state").then(setState, (e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    refresh();
    api<JournalEntry[]>("GET", "/api/journal").then(setJournal, () => {});
    return events((type, data) => {
      if (type === "journal") setJournal((j) => [...j.slice(-299), data as JournalEntry]);
      if (type === "approvals") setState((s) => (s ? { ...s, approvals: data as Approval[] } : s));
      if (type === "state") refresh();
    });
  }, [refresh]);

  if (!state) return <div className="boot">{error ? `Нет связи с ядром моста: ${error}` : "Запуск…"}</div>;

  const save = async (next: Config) => {
    setError("");
    try {
      setState(await api<State>("PUT", "/api/config", next));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveSecrets = async (body: Record<string, unknown>) => {
    setError("");
    try {
      setState(await api<State>("PUT", "/api/secrets", body));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>Agent Bridge</h1>
        <StatusPill state={state} />
      </header>

      <Problems state={state} onOpenSettings={() => setTab("settings")} />

      {error && <div className="error">{error}</div>}

      <Approvals items={state.approvals} />

      <LibreOfficeOffer state={state} onState={setState} onError={setError} />

      <PendingEdits items={state.edits} onError={setError} />

      <nav className="tabs">
        {(
          [
            ["folders", "Папки"],
            ["apps", "Программы"],
            ["journal", "Журнал"],
            ["settings", "Настройка"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "folders" && <FoldersTab cfg={state.config} onSave={save} />}
      {tab === "apps" && <AppsTab state={state} onSave={save} onState={setState} onError={setError} />}
      {tab === "journal" && <JournalTab entries={journal} />}
      {tab === "settings" && <SettingsTab state={state} onSave={save} onSecrets={saveSecrets} onState={setState} onError={setError} />}
    </div>
  );
}

// What stops the agent from working, in the user's words. Empty = ready.
function problems(state: State): string[] {
  const out: string[] = [];
  const f = state.frpc;
  if (f.problem) out.push(`Нет связи с сервером: ${f.problem}`);
  else if (!f.connected) out.push("Нет связи с сервером — переподключаюсь");
  const gate = (name: string, g: State["gates"]["terminal"]) => {
    if (g.enabled && g.status !== "up") out.push(`${name} не запустился${g.error ? `: ${g.error.slice(0, 160)}` : ""}`);
  };
  gate("Терминал", state.gates.terminal);
  gate("Браузер", state.gates.browser);
  gate("Программы", state.gates.apps);
  if (state.config.apps.office.enabled && state.office.runtime.state === "error") out.push(`Офисные файлы: ${state.office.runtime.message}`);
  return out;
}

function StatusPill({ state }: { state: State }) {
  const ok = problems(state).length === 0;
  return <span className={`pill ${ok ? "ok" : "bad"}`}>{ok ? "Работает" : "Не готов"}</span>;
}

function Problems({ state, onOpenSettings }: { state: State; onOpenSettings: () => void }) {
  const list = problems(state);
  if (!list.length) return null;
  return (
    <section className="problems">
      <ul>
        {list.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <button className="link" onClick={onOpenSettings}>
        Открыть настройку
      </button>
    </section>
  );
}

function Approvals({ items }: { items: Approval[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!items.length) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [items.length]);
  if (!items.length) return null;
  const decide = (id: string, approve: boolean) => api("POST", `/api/approvals/${id}`, { approve }).catch(() => {});
  return (
    <section className="approvals">
      {items.map((a) => {
        const left = Math.max(0, Math.round((Date.parse(a.expiresAt) - now) / 1000));
        return (
          <div key={a.id} className="approval">
            <div className="approval-head">
              <span className="tag">{GATE[a.gate] ?? a.gate}</span>
              <span className="muted small">автоотказ через {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>
            </div>
            <pre className="approval-title">{a.title}</pre>
            <details>
              <summary>{a.gate === "office" ? "Показать код" : "Подробности"}</summary>
              <pre className="small">{a.details}</pre>
            </details>
            <div className="row">
              <button className="primary" onClick={() => decide(a.id, true)}>
                Разрешить один раз
              </button>
              <button onClick={() => decide(a.id, false)}>Отклонить</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// Edits the agent handed over for review. They never expire: the user decides when ready.
function PendingEdits({ items, onError }: { items: EditRecord[]; onError: (e: string) => void }) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [stale, setStale] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const pending = items.filter((e) => e.status === "pending");
  if (!pending.length) return null;
  const call = async (id: string, what: "replace" | "cancel" | "open", body?: unknown) => {
    onError("");
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await api<ReplaceResult | { ok: boolean; message?: string }>("POST", `/api/edits/${id}/${what}`, body ?? {});
      if ("result" in r) {
        if (r.result === "stale") setStale((s) => ({ ...s, [id]: true }));
        else if (r.result === "locked" || r.result === "gone") setNote((n) => ({ ...n, [id]: r.message }));
        else setNote((n) => ({ ...n, [id]: "" }));
        if (r.result !== "stale") setStale((s) => ({ ...s, [id]: false }));
      } else if (!r.ok && r.message) setNote((n) => ({ ...n, [id]: r.message ?? "" }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };
  return (
    <section className="approvals">
      {pending.map((e) => (
        <div key={e.id} className="approval edit">
          <div className="approval-head">
            <span className="tag">Правки на проверке</span>
            <span className="muted small">{e.proposedAt ? new Date(e.proposedAt).toLocaleString("ru-RU") : ""}</span>
          </div>
          <div className="approval-title">{fileName(e.original)}</div>
          {e.summary && <p className="summary">{e.summary}</p>}
          <div className="muted small">
            Копия: <code>{e.copy}</code>
          </div>
          {stale[e.id] ? (
            <div className="stale">
              <p>Оригинал менялся после того, как агент сделал копию. Заменить всё равно? Ваша версия останется в бэкапе.</p>
              <div className="row">
                <button className="primary" disabled={busy[e.id]} onClick={() => void call(e.id, "replace", { force: true })}>
                  Заменить
                </button>
                <button disabled={busy[e.id]} onClick={() => setStale((s) => ({ ...s, [e.id]: false }))}>
                  Не заменять
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button disabled={busy[e.id]} onClick={() => void call(e.id, "open")}>
                Открыть копию
              </button>
              <button className="primary" disabled={busy[e.id]} onClick={() => void call(e.id, "replace")}>
                {busy[e.id] ? "⏳ Заменяю…" : "Заменить оригинал"}
              </button>
              <button disabled={busy[e.id]} onClick={() => void call(e.id, "cancel")}>
                Отменить правки
              </button>
            </div>
          )}
          {note[e.id] && <div className="warn small">{note[e.id]}</div>}
        </div>
      ))}
    </section>
  );
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// No Office and no LibreOffice: the agent asked to recalc or render — the user decides on the download.
function LibreOfficeOffer({ state, onState, onError }: { state: State; onState: (s: State) => void; onError: (e: string) => void }) {
  if (!state.office.libreOfficeOffer || state.office.libreOffice.installed) return null;
  const answer = (install: boolean) =>
    api<State>("POST", "/api/office/libreoffice", { install }).then(onState, (e) => onError((e as Error).message));
  return (
    <section className="approvals">
      <div className="approval">
        <div className="approval-head">
          <span className="tag">Офисные файлы</span>
        </div>
        <p>Чтобы пересчитывать формулы и показывать агенту вид документа, нужен LibreOffice (≈350 МБ). Скачать?</p>
        <div className="row">
          <button className="primary" onClick={() => void answer(true)}>
            Скачать
          </button>
          <button onClick={() => void answer(false)}>Не сейчас</button>
        </div>
      </div>
    </section>
  );
}

function AppsTab({ state, onSave, onState, onError }: { state: State; onSave: (c: Config) => void; onState: (s: State) => void; onError: (e: string) => void }) {
  const cfg = state.config;
  const office = cfg.apps.office;
  const rt = state.office.runtime;
  const d = state.office.detect;
  const lo = state.office.libreOffice;
  const setOffice = (patch: Partial<typeof office>) => onSave({ ...cfg, apps: { ...cfg.apps, office: { ...office, ...patch } } });
  const installLo = () => api<State>("POST", "/api/office/libreoffice", { install: true }).then(onState, (e) => onError((e as Error).message));
  const hasOffice = !!d && (d.office.excel || d.office.word || d.office.powerpoint);
  return (
    <section className="panel">
      <h2>Офисные файлы (Word, Excel, PowerPoint)</h2>
      <p className="muted small">
        Агент читает и правит документы прямо на этом компьютере — файлы никуда не уходят. Правит он копию рядом с оригиналом, а заменить
        оригинал решаете вы.
      </p>
      <label className="check">
        <input type="checkbox" checked={office.enabled} onChange={(e) => setOffice({ enabled: e.target.checked })} />
        Включить
      </label>
      {office.enabled && (
        <>
          <dl className="facts">
            <dt>Окружение</dt>
            <dd className={rt.state === "error" ? "bad" : rt.state === "ready" ? "ok" : ""}>
              {rt.state === "installing" && "⏳ "}
              {rt.message}
              {rt.state === "installing" && rt.percent !== undefined ? ` ${rt.percent} %` : ""}
            </dd>
            <dt>Программы</dt>
            <dd>
              {hasOffice ? (
                "Microsoft Office найден"
              ) : lo.status.state === "installing" || lo.status.state === "error" ? (
                <span className={lo.status.state === "error" ? "bad" : ""}>
                  LibreOffice: {lo.status.state === "installing" && "⏳ "}
                  {lo.status.message}
                  {lo.status.state === "installing" && lo.status.percent !== undefined ? ` ${lo.status.percent} %` : ""}
                </span>
              ) : lo.installed ? (
                "LibreOffice: установлен"
              ) : d ? (
                <>
                  LibreOffice: не установлен{" "}
                  <button className="link" onClick={() => void installLo()}>
                    Скачать
                  </button>
                </>
              ) : (
                <span className="muted">проверю, когда окружение будет готово</span>
              )}
            </dd>
          </dl>
          <p className="muted small">
            Скрипты агента проходят проверку пула: только библиотеки для документов, запись только в копии и новые файлы. Пул страхует от
            ошибок агента, не от взломанного агента.
          </p>
          <label className="check">
            <input type="checkbox" checked={office.trustScripts} onChange={(e) => setOffice({ trustScripts: e.target.checked })} />
            Скрипты вне пула — без вопроса
          </label>
          {office.trustScripts && <div className="error">Скрипты агента без проверки: всё, что выходит за пул, выполняется с вашими правами без вопроса.</div>}
        </>
      )}
    </section>
  );
}

function FoldersTab({ cfg, onSave }: { cfg: Config; onSave: (c: Config) => void }) {
  const [folder, setFolder] = useState("");
  return (
    <section className="panel">
      <p className="muted small">Отсюда агент читает без вопросов. Запись, запуск программ и всё вне этих папок — только с вашего подтверждения.</p>
      <ul className="list">
        {cfg.folders.map((f) => (
          <li key={f}>
            <code>{f}</code>
            <button className="link" onClick={() => onSave({ ...cfg, folders: cfg.folders.filter((x) => x !== f) })}>
              убрать
            </button>
          </li>
        ))}
        {!cfg.folders.length && <li className="muted">Папок нет — агент ничего не прочитает без вашего подтверждения.</li>}
      </ul>
      <div className="row">
        <input aria-label="Путь к папке" placeholder="C:\Users\Имя\Documents\Проект" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <button
          onClick={() => {
            const f = folder.trim();
            if (f && !cfg.folders.includes(f)) onSave({ ...cfg, folders: [...cfg.folders, f] });
            setFolder("");
          }}
        >
          Добавить папку
        </button>
      </div>
    </section>
  );
}

function Block({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="block" open={open}>
      <summary>{title}</summary>
      <div className="block-body">{children}</div>
    </details>
  );
}

function SettingsTab({
  state,
  onSave,
  onSecrets,
  onState,
  onError,
}: {
  state: State;
  onSave: (c: Config) => void;
  onSecrets: (b: Record<string, unknown>) => void;
  onState: (s: State) => void;
  onError: (e: string) => void;
}) {
  const cfg = state.config;
  return (
    <section className="panel settings">
      <Block title="Подключение к серверу" open={!!state.frpc.problem || !state.frpc.connected}>
        <ConnectionBlock state={state} onSave={onSave} onSecrets={onSecrets} />
      </Block>
      <Block title="Браузер">
        <BrowserBlock state={state} onSave={onSave} onSecrets={onSecrets} />
      </Block>
      <Block title="Терминал и подтверждения">
        <TerminalBlock cfg={cfg} onSave={onSave} />
      </Block>
      <Block title="Конфиг для места (VPS)">
        <PlaceBlock />
      </Block>
      <Block title="Автозапуск">
        <AutostartBlock state={state} onChange={onState} onError={onError} />
      </Block>
      <Block title="Служебное">
        <ServiceBlock state={state} />
      </Block>
    </section>
  );
}

function TerminalBlock({ cfg, onSave }: { cfg: Config; onSave: (c: Config) => void }) {
  const [timeout, setTimeoutSec] = useState(cfg.approvalTimeoutSec);
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={cfg.terminal.enabled} onChange={(e) => onSave({ ...cfg, terminal: { ...cfg.terminal, enabled: e.target.checked } })} />
        Выдать агенту терминал
      </label>
      <label className="check">
        <input type="checkbox" checked={cfg.terminal.autoAllow} onChange={(e) => onSave({ ...cfg, terminal: { ...cfg.terminal, autoAllow: e.target.checked } })} />
        Простые команды чтения в разрешённых папках — без вопроса
      </label>
      <div className="row">
        <label>
          Без ответа — отказ через, сек:{" "}
          <input type="number" min={5} max={600} value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))} style={{ width: 90 }} />
        </label>
        <button onClick={() => onSave({ ...cfg, approvalTimeoutSec: timeout })}>Сохранить</button>
      </div>
    </>
  );
}

function SecretField({ label, set, onSave }: { label: string; set: boolean; onSave: (v: string | null) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row">
        <input type="password" aria-label={label} placeholder={set ? "задан — введите новый, чтобы заменить" : "не задан"} value={v} onChange={(e) => setV(e.target.value)} />
        <button
          disabled={!v}
          onClick={() => {
            onSave(v);
            setV("");
          }}
        >
          Сохранить
        </button>
        {set && (
          <button className="link" onClick={() => onSave(null)}>
            удалить
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectionBlock({ state, onSave, onSecrets }: { state: State; onSave: (c: Config) => void; onSecrets: (b: Record<string, unknown>) => void }) {
  const cfg = state.config;
  const [addr, setAddr] = useState(cfg.frps.addr);
  const [port, setPort] = useState(cfg.frps.port);
  const [clientId, setClientId] = useState(cfg.clientId);
  return (
    <>
      <div className="field">
        <label>Адрес сервера</label>
        <input value={addr} onChange={(e) => setAddr(e.target.value.trim())} placeholder="cc.example.ru" />
      </div>
      <div className="field">
        <label>Порт</label>
        <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} style={{ width: 120 }} />
      </div>
      <div className="field">
        <label>Имя этого компьютера (уникально на сервере)</label>
        <input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} />
      </div>
      <button className="primary" onClick={() => onSave({ ...cfg, clientId, frps: { ...cfg.frps, addr, port } })}>
        Сохранить и переподключить
      </button>
      <SecretField label="Токен сервера" set={state.secretsSet.frpsToken} onSave={(v) => onSecrets({ frpsToken: v })} />
      <h3>Ключи</h3>
      <p className="muted small">Ключ туннеля и токен доступа мост создал сам. После смены их нужно заново перенести на место.</p>
      <div className="row">
        <button onClick={() => confirm("Сменить ключ туннеля? Место отключится до переноса нового конфига.") && onSecrets({ rotate: "sk" })}>Сменить ключ туннеля</button>
        <button onClick={() => confirm("Сменить токен доступа? Место отключится до переноса нового конфига.") && onSecrets({ rotate: "gateToken" })}>
          Сменить токен доступа
        </button>
      </div>
    </>
  );
}

function BrowserBlock({ state, onSave, onSecrets }: { state: State; onSave: (c: Config) => void; onSecrets: (b: Record<string, unknown>) => void }) {
  const cfg = state.config;
  const [exe, setExe] = useState(cfg.browser.executablePath);
  const [profile, setProfile] = useState(cfg.browser.profileDirName);
  const tools = { ...state.defaultBrowserTools, ...cfg.browser.tools };
  const setMode = (tool: string, mode: ToolMode) => onSave({ ...cfg, browser: { ...cfg.browser, tools: { ...cfg.browser.tools, [tool]: mode } } });
  return (
    <>
      <p className="muted small">Нужно расширение «Playwright Extension» из Chrome Web Store в Chrome, Brave или Edge.</p>
      <label className="check">
        <input type="checkbox" checked={cfg.browser.enabled} onChange={(e) => onSave({ ...cfg, browser: { ...cfg.browser, enabled: e.target.checked } })} />
        Выдать агенту браузер
      </label>
      <div className="field">
        <label>Путь к браузеру (пусто — Chrome)</label>
        <input value={exe} onChange={(e) => setExe(e.target.value)} placeholder="C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" />
      </div>
      <div className="field">
        <label>Профиль (пусто — последний с расширением)</label>
        <input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="Profile 1" />
      </div>
      <button onClick={() => onSave({ ...cfg, browser: { ...cfg.browser, executablePath: exe.trim(), profileDirName: profile.trim() } })}>Сохранить</button>
      <SecretField label="Токен расширения (на странице статуса расширения)" set={state.secretsSet.extensionToken} onSave={(v) => onSecrets({ extensionToken: v })} />
      <details className="nested">
        <summary>Что агент может делать в браузере</summary>
        <p className="muted small">По умолчанию смотреть страницы — сам, действовать на странице — с вопросом.</p>
        <table className="modes">
          <tbody>
            {Object.entries(tools).map(([tool, mode]) => (
              <tr key={tool}>
                <td>
                  <code>{tool.replace(/^browser_/, "")}</code>
                </td>
                <td>
                  {(["auto", "ask", "deny"] as ToolMode[]).map((m) => (
                    <label key={m} className="radio">
                      <input type="radio" checked={mode === m} onChange={() => setMode(tool, m)} />
                      {m === "auto" ? "сам" : m === "ask" ? "спросить" : "запрещено"}
                    </label>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function PlaceBlock() {
  const [bundle, setBundle] = useState<{ visitorToml: string; mcpJson: string } | null>(null);
  return (
    <>
      <p className="muted small">Переносится на место (VPS) один раз. Содержит ключи — не пересылайте в открытые чаты.</p>
      {!bundle ? (
        <button onClick={() => api<{ visitorToml: string; mcpJson: string }>("GET", "/api/place-bundle").then(setBundle)}>Показать конфиг для места</button>
      ) : (
        <>
          <Copyable title="frpc-visitor.toml" text={bundle.visitorToml} />
          <Copyable title=".mcp.json" text={bundle.mcpJson} />
          <button onClick={() => setBundle(null)}>Скрыть</button>
        </>
      )}
    </>
  );
}

function AutostartBlock({ state, onChange, onError }: { state: State; onChange: (s: State) => void; onError: (e: string) => void }) {
  const a = state.autostart;
  if (!a.supported) return <div className="muted">{a.detail}</div>;
  const toggle = async () => {
    try {
      onChange(await api<State>("PUT", "/api/autostart", { enabled: a.mode === "none" }));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="row">
      <span className={a.mode === "task" ? "ok" : a.mode === "runkey" ? "warn" : "muted"}>{a.detail}</span>
      <button onClick={toggle}>{a.mode === "none" ? "Включить" : "Выключить"}</button>
    </div>
  );
}

function ServiceBlock({ state }: { state: State }) {
  const f = state.frpc;
  return (
    <>
      <dl className="facts">
        <dt>Версия</dt>
        <dd>{state.version}</dd>
        <dt>Имя компьютера</dt>
        <dd>{state.config.clientId}</dd>
        <dt>Туннель</dt>
        <dd>{f.connected ? `подключён${f.proxies.length ? `, выдано: ${f.proxies.join(", ")}` : ""}` : f.problem || f.state}</dd>
        <dt>Данные</dt>
        <dd>
          <code>{state.dataDir}</code>
        </dd>
        <dt>Секреты</dt>
        <dd>{state.secretStore === "os" ? "хранилище ОС" : "файл"}</dd>
      </dl>
      <details className="nested">
        <summary>Лог туннеля</summary>
        <pre className="small">{f.logs.join("\n") || "пусто"}</pre>
      </details>
    </>
  );
}

function Copyable({ title, text }: { title: string; text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copyable">
      <div className="row">
        <strong>{title}</strong>
        <button
          className="link"
          onClick={() =>
            navigator.clipboard.writeText(text).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            })
          }
        >
          {done ? "скопировано" : "копировать"}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

const GATE: Record<string, string> = { terminal: "Терминал", browser: "Браузер", office: "Офисные файлы", system: "Мост" };

const OUTCOME: Record<string, string> = {
  auto: "сам",
  approved: "разрешено",
  denied: "отклонено",
  timeout: "таймаут",
  blocked: "заблокировано",
  info: "",
  error: "ошибка",
};

function JournalTab({ entries }: { entries: JournalEntry[] }) {
  return (
    <section className="panel">
      {!entries.length && <p className="muted">Пока пусто. Здесь будет каждое действие агента и ваше решение по нему.</p>}
      <table className="journal">
        <tbody>
          {[...entries].reverse().map((e, i) => (
            <tr key={i} className={`o-${e.outcome}`}>
              <td className="muted small">{new Date(e.ts).toLocaleTimeString("ru-RU")}</td>
              <td className="small">{GATE[e.gate] ?? e.gate}</td>
              <td>
                <code>{e.summary}</code>
                {e.reason && <div className="muted small">{e.reason}</div>}
              </td>
              <td className="small">{OUTCOME[e.outcome] ?? e.outcome}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
