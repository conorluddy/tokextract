// sections.jsx — page composition. One function per landing-page section.
// Sections read content from window.TOKEXTRACT and use the shared primitives.
//
// Scaffolding lifted from /Users/conor/Development/Vestige/docs (2026-05-08).
// CSS class prefix `vt-` retained from the lift; intentionally not rebranded for v1.

const { useState: sUseState } = React;

// ── Top bar ──────────────────────────────────────────────
function Bar() {
  const { meta } = window.TOKEXTRACT;
  return (
    <header className="vt-bar">
      <div className="vt-bar-l">
        <Mark size={20} />
        <span className="vt-brand-name">{meta.name.toUpperCase()}</span>
        <span className="vt-brand-meta">{meta.version}</span>
      </div>
      <nav className="vt-bar-r">
        <a href="#what">what</a>
        <a href="#install">install</a>
        <a href="#categories">categories</a>
        <a href="#validation">validation</a>
        <a href="#sample">sample</a>
        <a href="#pipeline">pipeline</a>
        <a href="#roadmap">roadmap</a>
        <a className="vt-cta-gh" href={meta.repo}>github →</a>
      </nav>
    </header>
  );
}

// ── Hero ─────────────────────────────────────────────────
function Hero() {
  const { hero } = window.TOKEXTRACT;
  const [copied, setCopied] = sUseState(false);
  const copy = () => {
    try { navigator.clipboard?.writeText(hero.install); } catch (_) {}
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section className="vt-hero">
      <div className="vt-hero-grid">
        <div>
          <div className="vt-kicker">{hero.kicker}</div>
          <h1>
            {hero.headline.map((line, i) => (
              <React.Fragment key={i}>
                {i === hero.headline.length - 1 ? <em>{line}</em> : line}
                {i < hero.headline.length - 1 && <br />}
              </React.Fragment>
            ))}
          </h1>
          <p>{hero.pitch}</p>
          <div className="vt-install">
            <div className="vt-install-cmd"><span className="vt-prompt">/</span> {hero.install.replace(/^\//, '')}</div>
            <button className="vt-install-copy" onClick={copy}>{copied ? 'COPIED' : 'COPY'}</button>
          </div>

          <div className="vt-statgrid">
            {hero.statgrid.map((s, i) => (
              <Stat key={i} k={s.k} v={s.v} />
            ))}
          </div>
        </div>

        <div>
          <div className="vt-fig-num">FIG. 01 — ARTIFACTS</div>
          <ArtifactsDiagram />
        </div>
      </div>
    </section>
  );
}

// Simple three-card diagram of the three output artifacts.
function ArtifactsDiagram() {
  const { what } = window.TOKEXTRACT;
  return (
    <Frame hard panel style={{ padding: 18 }}>
      <div style={{ display: 'grid', gap: 14 }}>
        {what.map((item, i) => (
          <div key={i} style={{ borderLeft: '2px solid var(--vt-accent)', paddingLeft: 12 }}>
            <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--vt-ink)' }}>
              {item.title}
            </div>
            <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 10, color: 'var(--vt-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 2 }}>
              {item.tag}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--vt-ink-soft)', marginTop: 6 }}>
              {item.desc}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ── What it produces ─────────────────────────────────────
function What() {
  const { what } = window.TOKEXTRACT;
  return (
    <Section id="what" n="02" title="Three artifacts." lede="One pass over your codebase. Three files out.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}>
        {what.map((item, i) => (
          <Frame key={i} panel style={{ padding: 16 }}>
            <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--vt-ink)' }}>
              {item.title}
            </div>
            <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 10, color: 'var(--vt-accent)', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4, marginBottom: 10 }}>
              {item.tag}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--vt-ink-soft)' }}>
              {item.desc}
            </div>
          </Frame>
        ))}
      </div>
    </Section>
  );
}

// ── Install ──────────────────────────────────────────────
function Install() {
  const { install } = window.TOKEXTRACT;
  return (
    <Section id="install" n="03" title={install.title} lede="Three commands. From any Claude Code session.">
      <div style={{ display: 'grid', gap: 12 }}>
        {install.steps.map((step, i) => (
          <div key={i}>
            <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 11, color: 'var(--vt-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
              {step.label}
            </div>
            <Pre style={{ marginTop: 0 }}>{step.cmd}</Pre>
          </div>
        ))}
        <p style={{ fontSize: 13, color: 'var(--vt-ink-soft)', marginTop: 6 }}>{install.note}</p>
      </div>
    </Section>
  );
}

// ── Token categories table ──────────────────────────────
function Categories() {
  const { categories } = window.TOKEXTRACT;
  return (
    <Section id="categories" n="04" title="Nine token categories." lede="Every category that matters in real-world SwiftUI, captured deterministically from the AST.">
      <Frame panel style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--vt-bg-soft)' }}>
              <th style={cellHead}>Category</th>
              <th style={cellHead}>Source patterns extracted</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--vt-border)' }}>
                <td style={{ ...cell, fontFamily: 'var(--vt-font-mono)', fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                  {cat.name}
                </td>
                <td style={{ ...cell, fontFamily: 'var(--vt-font-mono)', fontSize: 11.5, lineHeight: 1.55, color: 'var(--vt-ink-soft)' }}>
                  {cat.patterns}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Frame>
      <p style={{ fontSize: 12.5, color: 'var(--vt-muted)', marginTop: 12 }}>
        Vendor namespace for $extensions keys is derived from the target's Info.plist CFBundleIdentifier or .xcodeproj PRODUCT_BUNDLE_IDENTIFIER (multi-target-aware: skips Watch / Widget / Complications variants).
      </p>
    </Section>
  );
}

// ── Validation ──────────────────────────────────────────
function Validation() {
  const { validation } = window.TOKEXTRACT;
  return (
    <Section id="validation" n="05" title="Validated on two real apps." lede="Two structurally distinct iOS apps. End-to-end LLM-driven extraction. Both ship brand-correct DESIGN.md prose.">
      <Frame panel style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--vt-bg-soft)' }}>
              {validation.columns.map((c, i) => (
                <th key={i} style={cellHead}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {validation.rows.map((row, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--vt-border)' }}>
                {row.map((v, j) => (
                  <td key={j} style={{ ...cell, fontFamily: j === 0 ? 'var(--vt-font-sans)' : 'var(--vt-font-mono)', color: j === 0 ? 'var(--vt-ink)' : 'var(--vt-ink-soft)' }}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Frame>
    </Section>
  );
}

// ── Sample DESIGN.md prose ──────────────────────────────
function Sample() {
  const { sample } = window.TOKEXTRACT;
  return (
    <Section id="sample" n="06" title={sample.title} lede={`Source: ${sample.source}.`}>
      <Frame panel style={{ padding: 24 }}>
        <p style={{ fontSize: 16, lineHeight: 1.7, color: 'var(--vt-ink)', fontStyle: 'italic', margin: 0 }}>
          "{sample.prose}"
        </p>
      </Frame>
      <p style={{ fontSize: 12.5, color: 'var(--vt-muted)', marginTop: 12 }}>{sample.note}</p>
    </Section>
  );
}

// ── Pipeline ────────────────────────────────────────────
function Pipeline() {
  const { pipeline } = window.TOKEXTRACT;
  return (
    <Section id="pipeline" n="07" title={pipeline.title} lede={pipeline.lede}>
      <div style={{ display: 'grid', gap: 8 }}>
        {pipeline.steps.map((step, i) => (
          <Frame key={i} panel style={{ padding: 14, display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: 14, alignItems: 'baseline' }}>
            <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 18, fontWeight: 600, color: 'var(--vt-accent)' }}>{step.n}</div>
            <Pill tone={step.host === 'host Claude' ? 'accent' : undefined}>{step.host}</Pill>
            <div>
              <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--vt-ink)' }}>{step.name}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--vt-ink-soft)', marginTop: 4 }}>{step.desc}</div>
            </div>
          </Frame>
        ))}
      </div>
    </Section>
  );
}

// ── Roadmap ─────────────────────────────────────────────
function Roadmap() {
  const { roadmap } = window.TOKEXTRACT;
  return (
    <Section id="roadmap" n="08" title={roadmap.title} lede="Where it is. Where it's going.">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 11, color: 'var(--vt-accent)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12 }}>
            {roadmap.v1.label}
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {roadmap.v1.items.map((item, i) => (
              <li key={i} style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--vt-ink)', paddingLeft: 18, position: 'relative', marginBottom: 8 }}>
                <span style={{ position: 'absolute', left: 0, color: 'var(--vt-accent)' }}>✓</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div style={{ fontFamily: 'var(--vt-font-mono)', fontSize: 11, color: 'var(--vt-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12 }}>
            {roadmap.v2.label}
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {roadmap.v2.items.map((item, i) => (
              <li key={i} style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--vt-ink-soft)', paddingLeft: 18, position: 'relative', marginBottom: 8 }}>
                <span style={{ position: 'absolute', left: 0, color: 'var(--vt-muted)' }}>○</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

// ── Footer ──────────────────────────────────────────────
function Footer() {
  const { footer, meta } = window.TOKEXTRACT;
  return (
    <footer style={{ borderTop: '1px solid var(--vt-border)', paddingBlock: '24px', marginTop: 48, fontFamily: 'var(--vt-font-mono)', fontSize: 12, color: 'var(--vt-muted)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 16 }}>
      <div>
        Maintained by <a href={footer.site} style={{ color: 'var(--vt-ink-soft)' }}>{footer.maintainer}</a> · {footer.license} · <a href={meta.repo} style={{ color: 'var(--vt-ink-soft)' }}>github</a>
      </div>
      <div>{meta.name} {meta.version}</div>
    </footer>
  );
}

// ── Shared style snippets for tables ────────────────────
const cellHead = {
  textAlign: 'left',
  padding: '10px 14px',
  fontFamily: 'var(--vt-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--vt-muted)',
  fontWeight: 500,
};
const cell = {
  padding: '10px 14px',
};
