import { expect, test } from "bun:test"
import { decodeSeatmap, eventIdOf, eventim, freeTickets } from "./eventim.ts"

test("seat ids, positions, categories and availability are decoded from their deltas", () => {
  const seats = decodeSeatmap(
    {
      areas: [
        {
          blocks: [
            {
              name: "Orchestre",
              rows: [
                { seats: [[[100, 10, 50], [1, 10, 0], [1, 10, 0]]] },
                { seats: [[[200, 10, 80], [1, 10, 0]]] },
              ],
            },
          ],
        },
      ],
      labels: [
        { type: "ROW", text: "A", point: [0, 50] },
        { type: "ROW", text: "B", point: [0, 80] },
        { type: "BLOCK", text: "Orchestre", point: [0, 0] },
      ],
    },
    {
      priceCategories: [
        { id: 7, name: "Cat 1" },
        { id: 9, name: "Cat 2" },
      ],
      seats: [
        [100, 0, 7],
        [1, 0, 0],
        [100, 0, 2],
      ],
    },
    {
      seats: [
        [100, 1],
        [1, 0],
        [100, 1],
      ],
    },
  )

  expect(seats).toEqual([
    { id: "100", block: "Orchestre", row: "A", position: 1, category: "Cat 1", available: true },
    { id: "101", block: "Orchestre", row: "A", position: 2, category: "Cat 1", available: false },
    { id: "201", block: "Orchestre", row: "B", position: 2, category: "Cat 2", available: true },
  ])
})

test("eventim handles Fnac Spectacles pages and nothing else", () => {
  expect(eventim.matches(new URL("https://www.fnacspectacles.com/en/event/21844084/"))).toBe(true)
  expect(eventim.matches(new URL("https://fnacspectacles.com/event/1/"))).toBe(true)
  expect(eventim.matches(new URL("https://www.ticketmaster.fr/event/1"))).toBe(false)
  expect(eventim.matches(new URL("https://notfnacspectacles.com/"))).toBe(false)
})

test("free tickets are counted per category from seats and standing areas, leaving out categories with none", () => {
  const free = freeTickets(
    {
      priceCategories: [
        { id: 7, name: "Cat 1" },
        { id: 9, name: "Cat 2" },
        { id: 11, name: "Fosse" },
      ],
      seats: [
        [100, 0, 7],
        [1, 0, 0],
        [100, 0, 2],
      ],
      generalAdmissions: [[3640, 0, 11, [0]]],
    },
    {
      seats: [
        [100, 1],
        [1, 1],
        [100, 0],
      ],
      generalAdmissions: [[3640, 545, [[0, 545, 0]]]],
    },
  )

  expect([...free]).toEqual([
    ["Cat 1", 2],
    ["Fosse", 545],
  ])
})

test("the event id is the number at the end of the event page path", () => {
  expect(eventIdOf(new URL("https://www.fnacspectacles.com/event/benjamin-biolay-en-tournee-zenith-paris-la-villette-20811075/"))).toBe("20811075")
  expect(eventIdOf(new URL("https://www.fnacspectacles.com/en/event/le-roi-lion-21844084"))).toBe("21844084")
  expect(eventIdOf(new URL("https://www.fnacspectacles.com/artist/benjamin-biolay/"))).toBeUndefined()
})
