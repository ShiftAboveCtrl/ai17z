import { faker as current } from '@faker-js/faker';

export * from '@faker-js/faker';

// @farcaster/core 0.21 calls these 7.x APIs in its bundled test factories,
// including during module initialization. Keep the aliases local to this
// facade so other consumers still receive the unmodified, patched faker.
export const faker = Object.assign(Object.create(current), {
  datatype: Object.assign(Object.create(current.datatype), {
    number: ({ min = 0, max = min + 99_999 } = {}) => current.number.int({ min, max }),
    datetime: ({ min, max }) => current.date.between({ from: min, to: max }),
  }),
  random: {
    alphaNumeric: (length = 1) => current.string.alphanumeric({ length, casing: 'lower' }),
  },
  date: Object.assign(Object.create(current.date), {
    between: (from, to) => current.date.between(to === undefined ? from : { from, to }),
  }),
});
