// 以 node:sqlite 模擬 Cloudflare D1 的 prepare／bind／run／first／all，讓 worker/index.js 線上、本機共用。
// onWrite：有資料列被修改時呼叫（自動備份用）。
export function d1(database, onWrite = () => {}) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (args) => ({
        first: () => statement.get(...args) ?? null,
        all: () => ({ results: statement.all(...args) }),
        run: () => {
          const { changes } = statement.run(...args);
          if (changes > 0) onWrite();
          return { meta: { changes } };
        },
      });
      return { ...bound([]), bind: (...args) => bound(args) };
    },
  };
}
