/**
 * Stylesheet for the Qoder quota surfaces (the sidebar footer card and the
 * dashboard it opens) — a direct translation of commandcode's panel stylesheet
 * (src/client/panel-styles.ts), which the user held up as the reference look.
 * Classes are `qdp-` prefixed to stay clear of commandcode's `ccp-` set: both
 * plugins inject GLOBAL CSS into the same document, so the prefixes must not
 * collide.
 *
 * Same contract as the original: returned as a string (no DOM side effects at
 * import time), installed once by the client entry keyed by `data-plugin-css`,
 * and removed when the plugin's fiber unwinds. Every colour comes from a
 * harness theme alias with a neutral fallback.
 */

/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
export const QUOTA_CSS_ID = 'dsh-qoder-connect/QuotaPanel.module.css'

/** Install the stylesheet once; returns its disposer. */
export function injectQuotaCss(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${QUOTA_CSS_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-qoder-connect'
  tag.dataset.pluginCss = QUOTA_CSS_ID
  tag.textContent = QUOTA_CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

/** The quota panel stylesheet. */
export const QUOTA_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell's foot area renders this list ABOVE the Settings seat. The shell
   supplies no chrome: the entry is the button. Deliberately quiet — a surface
   beside Settings should read as part of the column — one hover step and a
   hairline border, exactly like commandcode's card.

   The shell's container is a flex ROW whose occupants each declare a
   full-width line, so as a row it overflows the column. The fix is the same
   load-bearing anchored rule commandcode ships (their issue #48): force the
   sidebar's footer-action container into a column, anchored to "_footArea"
   because "footerActions" is also used by the ask-user-question dialog — an
   unanchored rule would stack THAT dialog's buttons too. Anchoring keeps the
   fix scoped to the sidebar; the descendant combinator survives a wrapper
   appearing between the two. The rule is idempotent when commandcode is also
   installed (same selector, same declaration) and makes this plugin
   self-sufficient when it is not. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}
.qdp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.qdp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.qdp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.qdp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.qdp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
.qdp-updated{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* One block per merged package group: a head line carrying the group's own
   remain/total, then the FULL-WIDTH bar under it. Stacking the two lets the
   card show the figures — the reason this surface exists — without squeezing
   the bar into what is left beside them. */
.qdp-footRow{flex-direction:column;gap:4px;min-width:0;display:flex}
.qdp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.qdp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qdp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it renders inside the shell's
   own button — so these bars are spans, not divs. display:block is
   load-bearing on BOTH: an inline box ignores width and height outright, so
   without it the fill collapses to 0x0 and the bar shows no usage. */
.qdp-footBar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.qdp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.qdp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
/* 38px, not 34px: two-decimal copy is wider, and "99.61%" measures 36px in this
   font. nowrap keeps a long value from wrapping the row into a second line. */
.qdp-footPct{flex:none;width:38px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}

/* The 56px rail: one icon button on the shell's own rail geometry (36px cell),
   so the collapsed column keeps a single glyph like its siblings. */
.qdp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.qdp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* The ring glyph. Sized entirely by its own width/height attribute, so the
   footer row and the rail button can each ask for their own. */
.qdp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}
.qdp-ringWarn{color:var(--dsw-alias-state-error-primary)}

/* ------------------------------------------------------------ dashboard */
/* The center column in the layout frame: fill it, scroll the content column,
   and cap the reading width like the harness's own panels. */
.qdp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.qdp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.qdp-header{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.qdp-headerText{flex-direction:column;gap:2px;display:flex;min-width:0}
.qdp-title{margin:0;font-size:18px;font-weight:600;line-height:1.4}
.qdp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.qdp-spacer{flex:1}
.qdp-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums}
/* The dashboard's exit: an icon-sized glyph button. */
.qdp-close{min-width:28px;justify-content:center;padding-left:0;padding-right:0;box-sizing:border-box;align-items:center;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;height:28px;display:inline-flex}
.qdp-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.qdp-close span{font-size:16px;line-height:1}
.qdp-refresh{box-sizing:border-box;align-items:center;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;display:inline-flex;gap:6px;font-size:12px;line-height:18px}
.qdp-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qdp-refresh:disabled{opacity:.5;cursor:default}
.qdp-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* Notices: signed-out and error states. */
.qdp-notice{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;flex-direction:column;gap:4px;display:flex}
.qdp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.qdp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.qdp-noticeHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}

/* One card per variant. */
.qdp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:16px 18px;flex-direction:column;gap:16px;display:flex}
.qdp-cardHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.qdp-avatar{flex:none;width:28px;height:28px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform);border-radius:50%;justify-content:center;align-items:center;font-size:12px;font-weight:600;line-height:1;display:inline-flex}
.qdp-cardIdentity{flex-direction:column;gap:1px;min-width:0;display:flex}
.qdp-cardTitle{font-size:13px;font-weight:600;line-height:1.4}
.qdp-cardOwner{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}

/* Quota blocks: each merged group is a label row plus the track. */
.qdp-windows{flex-direction:column;gap:14px;display:flex}
.qdp-window{flex-direction:column;gap:6px;display:flex}
.qdp-windowHead{align-items:baseline;gap:8px;display:flex}
.qdp-windowLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:1.5}
.qdp-windowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}
.qdp-windowPct{color:var(--dsw-alias-label-primary);min-width:38px;text-align:right;font-size:12px;font-weight:600;line-height:1.5;font-variant-numeric:tabular-nums}
.qdp-bar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:8px}
.qdp-barFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.qdp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.qdp-windowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}

/* Badges. */
.qdp-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px}
.qdp-badgeError{background:transparent;color:var(--dsw-alias-state-error-primary)}
.qdp-badgeMuted{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;max-width:220px;overflow:hidden;text-overflow:ellipsis}

/* Overall remaining + share line, ahead of the detail table. */
.qdp-totalLine{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.qdp-totalValue{font-size:22px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;margin-left:6px}
.qdp-totalSub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}

/* Detail table: every package, unmerged. Column heads are the settings
   shell's tertiary smallcaps; numbers are tabular; the mini bar rides under
   the figures in the same cell like the reference layout. */
.qdp-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.qdp-table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;line-height:1.5;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--dsw-alias-border-l2);padding:4px 8px}
.qdp-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top}
.qdp-table tr:last-child td{border-bottom:0}
.qdp-num{min-width:150px}
.qdp-numText{display:block;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-bottom:3px}
.qdp-miniBar{display:block;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.qdp-expiry{white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* A summed bucket the API gives no date for links to the page that itemizes
   it. Understated until hovered: it is a way out, not the row's headline. */
.qdp-expiryLink{color:var(--dsw-alias-label-tertiary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.qdp-expiryLink:hover{color:var(--dsw-alias-brand-primary)}
.qdp-expiryLink:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:3px}

/* Variant switch: plain buttons, like the settings page's usage carousel. */
.qdp-tabs{flex-wrap:wrap;gap:6px;display:flex}
.qdp-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.qdp-tab:hover:not(.qdp-tabActive){color:var(--dsw-alias-label-primary)}
.qdp-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}

@media (prefers-reduced-motion:reduce){.qdp-footFill,.qdp-barFill{transition:none}}
`
