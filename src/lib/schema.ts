import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const transactions = sqliteTable('transactions', {
  transactionId: text('transaction_id').primaryKey(),
  accountId: text('account_id'),
  date: text('date').notNull(),
  datetime: text('datetime'),
  name: text('name'),
  merchantName: text('merchant_name'),
  amount: real('amount').notNull(),
  pfc: text('pfc'),
  category: text('category').notNull().default('uncategorized'),
  source: text('source').notNull().default('uncategorized'),
  raw: text('raw'),
});

export const rules = sqliteTable('rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull().unique(),
  category: text('category').notNull(),
  origin: text('origin').notNull().default('learned'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

export const overrides = sqliteTable('overrides', {
  transactionId: text('transaction_id').primaryKey(),
  category: text('category').notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});
