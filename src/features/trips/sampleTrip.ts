/** 「亚洲假期示例」：仅在用户点击后写入。不包含航空公司、航班号或起降时间。 */
export const SAMPLE_TRIP = {
  title: '亚洲假期示例',
  range: { startDate: '2026-09-26', endDate: '2026-10-05' },
  legs: [
    ['YNZ', 'ICN', '2026-09-26'],
    ['ICN', 'HKT', '2026-09-26'],
    ['HKT', 'ICN', '2026-10-02'],
    ['ICN', 'HKG', '2026-10-05'],
  ] as const,
}
