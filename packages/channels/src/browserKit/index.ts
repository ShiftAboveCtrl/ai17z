/**
 * The browser machinery every network shares.
 *
 * What is here has no opinion about which site it is driving: leasing a tab,
 * typing into a composer and proving it landed, attaching files, reading a
 * sign-in page, and asking a same-origin JSON endpoint. A network's own folder
 * supplies selectors and wording and calls these; it never copies them.
 *
 * Nothing in this folder may import from a network's folder. That is the
 * direction the dependency runs, and the test that would catch it is cheap:
 * `rg "from '\.\./x/" packages/channels/src/browserKit` must find nothing.
 */
export * from './tabSession';
export * from './composerDriver';
export * from './authObserver';
export * from './credentialLoop';
export * from './pageJson';
