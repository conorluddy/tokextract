// data.js — content for the Tokextract landing page.
// Edit copy here without touching markup.

const TOKEXTRACT = {
  meta: {
    name:    'Tokextract',
    tag:     'reverse-engineer a SwiftUI app\'s design system',
    repo:    'https://github.com/conorluddy/tokextract',  // public; repo will be created when ready to share
    version: 'v1.0.0',
    license: 'MIT',
  },

  hero: {
    kicker:  '┌─ CLAUDE CODE PLUGIN ─────────────',
    headline: [
      'Reverse-engineer your SwiftUI app\'s design system',
      'in seconds, not in a 2-week designer audit.',
    ],
    pitch:    'Tokextract walks any SwiftUI codebase, finds every color / font / spacing / radius / shadow / animation / component / glass / theme value, clusters near-duplicates, and emits W3C DTCG 2025.10 design tokens, an LLM-narrated DESIGN.md, and a drift audit. Goes the opposite direction of every other token tool — code → tokens, not Figma → code.',
    install: '/plugin install tokextract@conorluddy',
    statgrid: [
      { k: 'parser',    v: 'tree-sitter-swift' },
      { k: 'output',    v: 'DTCG 2025.10' },
      { k: 'narrative', v: 'DESIGN.md (Google alpha)' },
      { k: 'fixtures',  v: 'Grapla + Ocras' },
      { k: 'tests',     v: '246 passing' },
      { k: 'parse',     v: '4s on 727 files' },
    ],
  },

  what: [
    {
      title:    'tokens.json',
      tag:      'machine truth',
      desc:     'W3C DTCG 2025.10 design tokens. Modern color spaces (sRGB / Display P3 / OKLCH). Composite types for typography and shadow. $extensions for animation and Liquid Glass. Schema-validated before write.',
    },
    {
      title:    'DESIGN.md',
      tag:      'agent-readable narrative',
      desc:     'Google @google/design.md alpha format. LLM-generated brand prose covering Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do\'s and Don\'ts. Lint-checked against 8 rules. Drops in next to your CLAUDE.md.',
    },
    {
      title:    'audit.md',
      tag:      'drift report',
      desc:     'Magic numbers, near-duplicate color clusters (CIEDE2000 ΔE), off-scale spacing/radius, orphaned tokens, Liquid Glass content-layer violations, and ranked LLM harmonization recommendations with confidence labels and source line references.',
    },
  ],

  install: {
    title: 'Install',
    steps: [
      { label: 'Add the marketplace (one-time):',  cmd: '/plugin marketplace add conorluddy/tokextract' },
      { label: 'Install the plugin (one-time):',   cmd: '/plugin install tokextract@conorluddy' },
      { label: 'Run it on any SwiftUI repo:',      cmd: '/tokextract:extract --path <swift-repo> --output <dir>' },
    ],
    note: 'Agent spawns Haiku/Sonnet subagents for the LLM stages. No separate API key needed. For deterministic / CI use without LLM passes, run the bundled CLI directly with --no-llm.',
  },

  categories: [
    { name: 'Color',        patterns: 'extension Color, Color(hex:), Color(.sRGB,…), Color("Asset", bundle:), Color(.assetName), .foregroundColor(.foo) shorthand, hex byte arithmetic (0xF3 / 255), Asset Catalog .colorset walk including dark/HC variants' },
    { name: 'Typography',   patterns: 'Font.custom, extension Font static lets, extension Text { textStyleX() }, custom font enums (both : String { case } and static let *Name styles), font-weight inference from PostScript suffix' },
    { name: 'Spacing',      patterns: '.padding(N), .padding(.horizontal, N), EdgeInsets, VStack(spacing:), enum Spacing { static let xs = 4 }' },
    { name: 'Shape / radius', patterns: '.cornerRadius, RoundedRectangle(cornerRadius:style:), UnevenRoundedRectangle, Circle / Capsule / Ellipse / ContainerRelativeShape' },
    { name: 'Shadow',       patterns: '.shadow(color:radius:x:y:), extension View wrappers' },
    { name: 'Animation',    patterns: '.easeInOut, .spring(response:dampingFraction:), withAnimation, extension Animation' },
    { name: 'Components',   patterns: 'ButtonStyle, ViewModifier, extension View convenience wrappers, custom View structs (with confidence tiering)' },
    { name: 'iOS 26 Liquid Glass', patterns: '.glassEffect(), GlassEffectContainer, content-layer-violation audit flag' },
    { name: 'Theme injection', patterns: 'EnvironmentKey, EnvironmentValues extensions, @Entry macro, @Observable providers' },
  ],

  validation: {
    columns: ['', 'Grapla (BJJ tracker)', 'Ocras (fasting tracker)'],
    rows: [
      ['.swift files',           '727',                       '~250'],
      ['Parse time',             '4 seconds',                 '<2 seconds'],
      ['Color tokens',           '113',                       '23'],
      ['Typography tokens',      '5',                         '5'],
      ['Total DTCG tokens',      '270',                       '40'],
      ['Harmonize recs',         '29 (23 high-conf)',         '9 (7 high)'],
      ['DESIGN.md prose',        '346 lines (BJJ-correct)',   '266 lines (fasting-correct)'],
      ['DESIGN.md lint',         '8 / 8',                     '8 / 8'],
    ],
  },

  sample: {
    title:  'Sample LLM-generated DESIGN.md',
    source: 'Ocras — a fasting tracker',
    prose:  'Ocras is a fasting tracker. Its core job is communicating a single binary state — fasting vs. eating — at a glance, across iPhone, Apple Watch, and multiple widget families. Every design decision flows from that constraint: reduce cognitive load, maximize legibility in small viewports, and let color carry the primary status signal.',
    note:   'Sonnet wrote this from the extracted token graph. The brand intent comes from inference over the names, scale, and structure of what the tool found in the source — not from hand-written prompts about Ocras.',
  },

  pipeline: {
    title: 'Pipeline',
    lede:  'Eight steps. Five Node, three Agent. The LLM stages are skipped entirely in --no-llm mode.',
    steps: [
      { n: '1', host: 'Node',         name: 'parse',           desc: 'tree-sitter-swift × 9 category parsers (shared parse tree; query cache; ~4s on 727 files). Emits findings.raw.json + clusters.json + LLM task manifest.' },
      { n: '2', host: 'Agent',  name: 'normalize',       desc: 'Spawns 1-N Haiku subagents in parallel (≤50 declarations per chunk per category). Slim Mapping[] output stays under the 20k output cap.' },
      { n: '3', host: 'Node',         name: 'plan-harmonize',  desc: 'Appends harmonize task to manifest, slim cluster summaries inlined into the prompt.' },
      { n: '4', host: 'Agent',  name: 'harmonize',       desc: 'Sonnet subagent. Outputs ranked recommendations with confidence labels and canonical-token-name proposals.' },
      { n: '5', host: 'Node',         name: 'emit',            desc: 'Merges all LLM outputs + deterministic findings → DTCG-valid tokens.json + audit.md. Diff section auto-prepended on re-runs.' },
      { n: '6', host: 'Node',         name: 'plan-narrate',    desc: 'Appends narrate task referencing tokens.json + audit.md.' },
      { n: '7', host: 'Agent',  name: 'narrate',         desc: 'Sonnet subagent reads the artifacts and Writes DESIGN.md directly.' },
      { n: '8', host: 'Node',         name: 'finalize',        desc: '8-rule DESIGN.md lint + summary print.' },
    ],
  },

  roadmap: {
    title:  'Roadmap',
    v1: {
      label: 'v1 ships',
      items: [
        '9-category SwiftUI parser (color, typography, spacing, shape, shadow, animation, component, glass, theme)',
        'Slim-mapping LLM contract (no subagent hits the 20k output cap)',
        'Lazy-staged pipeline with Node helpers (no dependsOn graph)',
        'Vendor namespace from Info.plist or .xcodeproj (multi-target-aware)',
        'Live-LLM smoke validated on Grapla + Ocras (both produce brand-correct DESIGN.md)',
        '246 unit + e2e tests, golden fixture snapshots',
      ],
    },
    v2: {
      label: 'v2 candidates',
      items: [
        'GitHub-hosted marketplace distribution (esbuild bundle for native deps, or post-install hook)',
        'SwiftSyntax-based --accurate parser (opt-in for Apple-toolchain users)',
        'Direct Figma Variables REST API push (Enterprise)',
        '--watch mode',
        'UIKit fallback for non-SwiftUI codebases',
        'MCP server for non-Claude-Code agents',
      ],
    },
  },

  footer: {
    maintainer: 'Conor Luddy',
    site:       'https://www.conor.fyi',
    github:     'https://github.com/conorluddy',
    license:    'MIT',
  },
};

window.TOKEXTRACT = TOKEXTRACT;
