# SplitCart

A small web app for neighbors in the same building to combine grocery orders into one delivery and split the fees fairly.

## Why

A delivery fee is a flat cost per drop-off. When several households in one building order on the same day, one delivery can serve all of them, so the fee (and often the free-delivery minimum) is shared instead of paid several times over.

## How it will work

1. A host opens a planned order: store, cutoff time, delivery slot.
2. Neighbors in the building join and add their items.
3. At the cutoff the host places the order from their own account.
4. The app works out each person's share of the fees and their total.
5. Everyone picks up their own bags at the lobby.

## Status

Work in progress, built in small pieces.

- [ ] Fee-splitting logic (integer cents, no lost or invented pennies)
- [ ] Order model and state machine
- [ ] API and persistence
- [ ] Web UI
- [ ] Payment holds (Stripe test mode)

## Development

```
npm install
npm test
```
