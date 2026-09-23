import { expect, test } from "bun:test"
import { type Availability, describeChanges } from "./watch.ts"

const soldOut: Availability = {
  event: "Bjork",
  status: "sold_out",
  categories: [
    { name: "Cat 1", price: "89 EUR", status: "sold_out" },
    { name: "Cat 2", price: "59 EUR", status: "sold_out" },
  ],
}

test("identical availability has no changes", () => {
  expect(describeChanges(soldOut, soldOut)).toEqual([])
})

test("a category coming back on sale is reported with the status change", () => {
  const next: Availability = {
    ...soldOut,
    status: "on_sale",
    categories: [soldOut.categories[0]!, { name: "Cat 2", price: "59 EUR", status: "available" }],
  }
  expect(describeChanges(soldOut, next)).toEqual(["status sold_out → on_sale", "Cat 2: sold_out → available"])
})

test("price changes, new categories and removed categories are each reported", () => {
  const next: Availability = {
    ...soldOut,
    categories: [
      { name: "Cat 1", price: "99 EUR", status: "sold_out" },
      { name: "Pit", price: "120 EUR", status: "available" },
    ],
  }
  expect(describeChanges(soldOut, next)).toEqual([
    "Cat 1: price 89 EUR → 99 EUR",
    "new category Pit: available, 120 EUR",
    "category Cat 2 no longer listed",
  ])
})
