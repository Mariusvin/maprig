# Editorial Instrument Web System

## Authority

This is the primary visual foundation for website and web application work. Use it by default unless the user supplies another visual reference. A user-supplied reference takes precedence for that project.

When another reference is provided, study its typography, composition, color, imagery, geometry, spacing, motion, and interaction patterns. Extract the underlying system and adapt it to the product. Do not copy its assets, brand, or page structure literally.

## Source And Intent

Editorial Instrument is inspired by the independent editorial character of [Partyzanai](https://www.partyzanai.com/).

The reference feels like a working cultural archive rather than a polished template. Its character comes from a narrow paper surface, compact monospaced text, black and white structure, electric violet emphasis, sparse imagery, visible indexing, hard rules, raw alignment, and asymmetric composition.

The reusable system preserves that economy, authorship, tension, and anti-generic quality while improving accessibility and adapting the information architecture to each domain.

The result should feel:

- authored, not templated;
- compact, not cramped;
- technical, not sterile;
- raw, not unfinished;
- expressive, not decorative;
- operational, not promotional.

## Core Principle

Treat each interface as an editorial instrument: an index, ledger, sequence, archive, or working document. Controls belong beside the content they affect. Useful structure such as numbering, status, duration, hierarchy, and metadata should remain visible.

Do not default to floating cards, marketing composition, or decorative containers.

## Color System

Default tokens:

- Ink: `#0a0a0a`
- Paper: `#fffefb`
- Muted paper: `#f1f0eb`
- Rule: `#b8b6ae`
- Electric violet: `#6600cc`
- Violet wash: `#eee2ff`
- Error: `#b42116`
- Success: `#167044`

Black and paper dominate. Violet signals action, selection, links, and cultural energy. It is not a full-page theme. Subject imagery supplies the broader color range.

Do not use gradients, colored shadows, translucent blur, glows, floating color blobs, or a palette dominated by related violet tones.

## Typography

Use a monospaced family for interface text. Prefer `IBM Plex Mono` when locally available, with `ui-monospace`, `SFMono-Regular`, `Consolas`, and `Courier New` as fallbacks.

Use four stable levels:

- Identity: 28-40px, bold, compact line height
- Section title: 16-20px, bold
- Working text: 12-14px, regular
- Metadata: 10-12px, uppercase only where useful

Do not scale font size with viewport width. Do not use negative letter spacing. Do not sacrifice readability to mimic the reference's smallest type.

## Geometry And Spacing

- Default radius: `0`
- Permitted radius: `2px` for native focus affordances only
- Border width: `1px`
- Shadow: none
- Primary spacing unit: `4px`
- Common gaps: `8px`, `12px`, `16px`, `24px`, `32px`
- Comfortable control height: `32-36px`

Use solid and dashed rules, aligned columns, indentation, numbering, and whitespace to group information. Do not float page sections as cards. Never place cards inside cards.

## Optical Pattern

An original optical pattern may frame the working surface on wide screens. Build it with CSS geometry or an original asset. Never copy the source site's pattern image.

The pattern must:

- use ink, paper, and violet;
- remain subordinate to content;
- occupy margins or small identity regions;
- never sit behind editable or long-form text.

## Bounded Canvas And Open Field

Treat the primary interface as a bounded paper canvas inside an open patterned field. The canvas owns the composition. The field owns all viewport area the canvas does not occupy.

For composition-led sites, retain a deliberate fixed or minimum canvas width. When the viewport is narrower, allow native horizontal and vertical scrolling and preserve browser pinch zoom. Do not automatically collapse every composition into a mobile stack. Do not replace native movement with custom drag physics or transformed canvas controls.

The pattern should appear naturally when the viewport is wider than the canvas or when the user zooms out. At default narrow-screen zoom, the paper may extend beyond the viewport and be explored through native panning.

## Layout Grammar

Choose structure according to the product, not according to a fixed template.

For operational products, prefer:

1. A narrow rail for identity, primary workflow navigation, and counts.
2. A flexible working column for the main task.
3. A contextual inspector for details, history, or output.

For editorial, portfolio, commerce, venue, and object-focused sites, use an asymmetric paper canvas, persistent index, image-led content rhythm, and visible metadata. Keep the actual subject prominent in the first viewport.

Use stable grid tracks and minmax constraints so controls, labels, images, counters, and dynamic content do not shift the layout.

## Responsive Rules

Desktop may show a patterned outer frame and two or three functional columns.

Tablet should compress navigation and move secondary inspection content beneath the active section.

For a bounded editorial canvas, mobile should preserve spatial relationships and allow native two-axis movement. For workflows where panning would obstruct a critical action, use a focused viewport-width editor for that action without dismantling the surrounding canvas. Text, buttons, and controls must never overlap or clip inside the canvas.

## Navigation

Navigation should read like an index:

- short labels;
- visible current location;
- optional numeric counts;
- no oversized pills;
- no floating navigation card;
- underline or violet marker for hover and focus;
- solid violet only for the active primary state.

Use familiar icons for icon-only commands. Give every unfamiliar icon a tooltip and accessible label.

## Controls

Primary actions use ink or violet fill with paper text. Secondary actions use underlined text, a familiar icon, or a plain bordered control. Destructive actions use the error color only at the point of action.

Inputs use:

- paper background;
- one-pixel ink or rule border;
- a visible label;
- violet focus outline;
- compact but usable padding;
- stable dimensions appropriate to the content.

Place edit, copy, refresh, save, and export actions beside the exact content they affect.

## Imagery

Use visual assets whenever the subject benefits from inspection. Show the actual product, object, place, material, person, state, or gameplay. Do not use vague atmosphere as a substitute for the subject.

Images should be sharp, direct, and lightly processed. Give repeated images a stable aspect ratio. Use one stronger image as an anchor when hierarchy needs it.

Do not copy reference-site artwork. Avoid dark overlays, blurred stock imagery, decorative illustrations, and meaningless texture panels.

## Motion

Motion is brief and functional:

- 120-180ms state transitions;
- immediate selection feedback;
- optional one-pass scan or rule movement for loading;
- no parallax, floating elements, springy cards, or ornamental entrance sequences;
- always honor `prefers-reduced-motion`.

## Domain Adaptation

- Operational products prioritize scanning, comparison, and repeated action.
- Portfolios prioritize image rhythm, authorship, project metadata, and work inspection.
- Shops prioritize product imagery, price, variants, inventory, and checkout clarity.
- Publications prioritize reading measure, issue structure, chronology, and archive navigation.
- Venue and event sites prioritize identity, schedule, location, tickets, and current programming.
- Object and product pages place the object in the first viewport and keep inspection imagery clear.
- Games may borrow the type, contrast, indexing, and pattern while allowing more motion and illustration.

Preserve the philosophy and token discipline. Adapt the information architecture and density to the audience and workflow.

## Anti-Patterns

Do not introduce:

- generic SaaS card grids;
- rounded pills for ordinary labels or navigation;
- oversized marketing headlines inside tools;
- purple gradients or violet-tinted everything;
- glass effects, blur panels, glows, or decorative orbs;
- decorative charts with no operational value;
- explanatory feature copy inside a working interface;
- nested panels;
- icon buttons without labels or tooltips;
- copied logos, images, patterns, or layouts;
- tiny type that harms accessibility;
- decorative whitespace that slows repeated workflows.

## Delivery Checklist

Before finishing a website or web application, verify:

- The result visibly follows Editorial Instrument or the user-supplied reference.
- The design fits the domain instead of repeating one fixed page layout.
- No generic card-dashboard or default landing-page composition remains.
- The subject is visible in the first viewport when the site is product, place, person, venue, or object focused.
- Images have stable dimensions and render correctly.
- Every action is complete, accessible, and located near its target.
- Keyboard focus is visible.
- Reduced-motion preferences are respected.
- Desktop and narrow-screen layouts have no overlap, clipping, or unintended overflow inside the canvas.
- Bounded canvases preserve native horizontal movement when they are wider than the viewport.
- Browser pinch zoom remains enabled.
- Color contrast and type size remain readable.
- No reference-site asset or brand element was copied.
- The implemented result was visually inspected at desktop and mobile sizes.
