import type { ReactNode } from 'react'
import type { ContextState, SettingsView } from '../../../shared/types'
import { presentModel } from '../../../shared/modelNames'
import { baseName, formatTokens } from '../utils'
import { useT } from '../i18n'
import { ArrowRightIcon, BookIcon, CompressIcon, LockIcon, ShieldIcon, UsersIcon } from './Icons'
import { ProviderLogo, brandForProvider, type LogoBrand } from './ProviderLogo'

interface WelcomeProps {
  settings: SettingsView
  ready: boolean
  context: ContextState | null
  onOpenSettings: () => void
  onOpenUnlocker?: () => void
  onImportGoogle?: () => void
  onAddDeepSeek?: () => void
}

function lineBreaks(text: string): ReactNode[] {
  return text.split('\n').flatMap((line, index) =>
    index === 0 ? [line] : [<br key={index} />, line]
  )
}

function WelcomeArt(): ReactNode {
  return (
    <div className="welcome-art" aria-hidden="true">
      <span className="art-grid" />
      <div className="art-frame">
        <div className="art-frame-bar">
          <span className="art-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="art-frame-title">agent</span>
          <span className="art-frame-live" />
        </div>
        <div className="art-thread">
          <div className="art-bubble">
            <span />
            <span />
            <span className="short" />
          </div>
          <div className="art-step">
            <span className="art-step-mark">✓</span>
            <span className="art-step-name">read</span>
            <span className="art-step-path">src/App.tsx</span>
            <span className="art-step-time">18 ms</span>
          </div>
          <div className="art-step">
            <span className="art-step-mark">✓</span>
            <span className="art-step-name">edit</span>
            <span className="art-step-path">src/shell.tsx</span>
            <span className="art-step-diff">
              <b>+42</b>
              <i>−9</i>
            </span>
          </div>
          <div className="art-step running">
            <span className="art-step-mark">›</span>
            <span className="art-step-name">run</span>
            <span className="art-step-path">npm run typecheck</span>
            <span className="art-spinner" />
          </div>
        </div>
        <div className="art-frame-foot">
          <span>4 steps</span>
          <span className="art-foot-bar">
            <i />
          </span>
          <span>2.1k tok</span>
        </div>
      </div>
      <div className="art-pane">
        <div className="art-pane-head">
          <span>pwsh</span>
          <span className="art-pane-dots">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="art-pane-line">
          <span className="art-prompt">❯</span> npm run dev
        </div>
        <div className="art-pane-line dim">ready in 412 ms</div>
        <div className="art-pane-line">
          <span className="art-prompt">❯</span>
          <span className="art-caret" />
        </div>
      </div>
    </div>
  )
}

export function Welcome({
  settings,
  ready,
  context,
  onOpenSettings,
  onOpenUnlocker,
  onImportGoogle,
  onAddDeepSeek
}: WelcomeProps): ReactNode {
  const { t, tc } = useT()
  const projectName = baseName(settings.activeProjectPath)
  const activeProvider =
    settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? null
  const activeModel = settings.activeModel
  const presentation = activeModel
    ? presentModel(activeModel, activeProvider?.label, activeProvider?.baseUrl)
    : null
  const providerMarks: { brand: LogoBrand; label: string }[] = []
  for (const provider of settings.providers) {
    const brand = brandForProvider(provider)
    if (!providerMarks.some((mark) => mark.brand === brand)) {
      providerMarks.push({ brand, label: provider.label })
    }
  }

  const remaining = context ? Math.max(0, context.limit - context.used) : null
  const autoCompactAt = context ? Math.round(context.threshold * 100) : settings.compactAt

  return (
    <section className="welcome">
      <div className="welcome-copy">
        <div className="welcome-meta">
          <span className="welcome-api-stack" aria-hidden="true">
            {providerMarks.length > 0 ? (
              providerMarks.slice(0, 4).map((mark) => (
                <ProviderLogo
                  key={mark.brand}
                  brand={mark.brand}
                  size={23}
                  className="welcome-api-logo"
                />
              ))
            ) : (
              <span className="welcome-api-empty">
                <LockIcon size={12} />
              </span>
            )}
          </span>
          <span className="welcome-meta-text">
            {presentation ? (
              <>
                <strong>{presentation.display}</strong>
                {activeProvider && <span> · {activeProvider.label}</span>}
              </>
            ) : (
              t('w.modelNone')
            )}
          </span>
          <span className="welcome-sep" />
          <span className={`welcome-live${ready ? '' : ' waiting'}`}>
            <span className="welcome-live-dot" />
            {t(ready ? 'w.ready' : 'w.needKey')}
          </span>
        </div>

        <h1 className="hero-title">
          {projectName
            ? (() => {
                const [head = '', tail = ''] = t('w.helloProject').split('{name}')
                return (
                  <>
                    <span className="hero-line">{lineBreaks(head)}</span>
                    <span className="hero-em">{projectName}</span>
                    {tail}
                  </>
                )
              })()
            : (() => {
                const [head = '', tail = ''] = t('w.helloPlain').split('\n')
                return (
                  <>
                    <span className="hero-line">{head}</span>
                    <br />
                    <span className="hero-em">{tail}</span>
                  </>
                )
              })()}
        </h1>

        <p className="hero-sub">
          {t(settings.activeProjectPath ? 'w.subProject' : 'w.subPlain')}
        </p>

        <div className="hero-status">
          {remaining !== null && (
            <span className="status-pill">
              <CompressIcon size={13} />
              {t('w.free', { n: formatTokens(remaining) })}
            </span>
          )}
          <span className="status-pill status-soft">
            {t('w.autoCompact', { n: autoCompactAt })}
          </span>
          {settings.skills.some((skill) => skill.enabled) && (
            <span className="status-pill status-soft">
              <BookIcon size={12} />
              {tc('unit.skill', settings.skills.filter((skill) => skill.enabled).length)}
            </span>
          )}
          {settings.agents.length > 0 && (
            <span className="status-pill status-soft">
              <UsersIcon size={12} />
              {tc('unit.agent', settings.agents.length)}
            </span>
          )}
        </div>

        <div className="nano-power-box">
          <div className="nano-power-header">
            <span className="nano-power-title">⚡ Nano Power Pack</span>
            <span
              className="nano-unlocker-tag"
              onClick={onOpenUnlocker}
              role="button"
              tabIndex={0}
              title="Нажмите для открытия настроек AgyUnlocker (Ctrl+U)"
            >
              <span className="nano-dot" /> AgyUnlocker: 127.0.0.1:53129 (Active)
            </span>
          </div>
          <div className="nano-power-actions">
            {onImportGoogle && (
              <button
                type="button"
                className="nano-chip-btn nano-google-chip"
                onClick={onImportGoogle}
                title="Подключить аккаунт Google из Antigravity без ввода ключей"
              >
                <ProviderLogo brand="google" size={15} />
                <span>Google (Gemini Pro/Ultra)</span>
                <span className="nano-chip-pill">1-Click</span>
              </button>
            )}
            {onAddDeepSeek && (
              <button
                type="button"
                className="nano-chip-btn nano-deepseek-chip"
                onClick={onAddDeepSeek}
                title="Добавить DeepSeek Chat & R1"
              >
                <ProviderLogo brand="deepseek" size={15} />
                <span>DeepSeek (Chat & R1)</span>
              </button>
            )}
            {onOpenUnlocker && (
              <button
                type="button"
                className="nano-chip-btn"
                onClick={onOpenUnlocker}
                title="Настройки обхода блокировок и прокси"
              >
                <ShieldIcon size={14} />
                <span>AgyUnlocker (Ctrl+U)</span>
              </button>
            )}
            <a
              href="http://localhost:4242"
              target="_blank"
              rel="noreferrer"
              className="nano-chip-btn nano-remote-chip"
              title="Открыть пульт управления в браузере или с телефона"
            >
              <span>📱 Remote Control :4242</span>
            </a>
          </div>
        </div>

        {!ready && (
          <div className="hero-setup">
            <span className="hero-setup-icon">
              <LockIcon size={18} />
            </span>
            <div className="hero-setup-copy">
              <strong>{t('w.connectTitle')}</strong>
              <span>{t('w.connectBody')}</span>
            </div>
            <button type="button" className="primary-btn" onClick={onOpenSettings}>
              {t('w.connectBtn')}
              <ArrowRightIcon size={15} />
            </button>
          </div>
        )}
      </div>

      <WelcomeArt />
    </section>
  )
}
