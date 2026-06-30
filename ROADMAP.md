# Wheel Edge Development Roadmap

## 🖥️ Note: Electron Setup Complete

The desktop app infrastructure is **already configured and ready to use**:

```bash
# Development (with hot reload)
npm run electron-dev

# Production build (creates .exe/.dmg/.AppImage)
npm run electron-build

# All platforms
npm run electron-build-all
```

You can use Electron from Phase 1 onward. No additional setup needed. Just run the commands above to package your app as a desktop application for Windows, macOS, or Linux.

See **README.md** for detailed Electron instructions.

---

## Phase 1: ✅ Complete - Application Shell

### Deliverables
- [x] React Router setup with 8 routes
- [x] Fixed sidebar navigation
- [x] Design system (colors, typography, gradients)
- [x] 8 page shells with mock data
- [x] Account snapshot widget
- [x] Zustand state management foundation
- [x] TailwindCSS configuration
- [x] Package.json with dependencies
- [x] **Electron setup (main.js, preload.js, electron-builder config)**
- [x] **Electron build scripts (npm run electron-dev/build)**

### Testing Checklist
- [ ] All 8 pages load without errors
- [ ] Sidebar navigation works from every page
- [ ] Account snapshot shows correct values
- [ ] Responsive layout on desktop (1920px+)
- [ ] Mock data displays in tables correctly
- [ ] No console warnings/errors

### Next: Phase 2

---

## Phase 2: Dashboard Logic & Metrics

### Pages Affected
- Dashboard (primary)

### Features to Add

#### 2.1 Position Summary Cards
- [ ] Calculate total open positions
- [ ] Calculate total premium collected
- [ ] Calculate average DTE
- [ ] Calculate win rate from journal
- [ ] Show current P&L

#### 2.2 Upcoming Expirations Widget
- [ ] Filter calendar for next 7 days
- [ ] Show by symbol
- [ ] Quick action buttons (roll, close, assign)

#### 2.3 Wheel Stage Distribution
- [ ] Count positions in each stage (put sold, assigned, CC, etc.)
- [ ] Show as pie/donut chart (Recharts)
- [ ] Color code by status

#### 2.4 Performance Metrics
- [ ] Monthly premium trend
- [ ] Win rate chart
- [ ] Avg return per cycle
- [ ] Avg days to close

### Dependencies
- Recharts for charts
- date-fns for date filtering

### Estimated Effort
⏱️ 4-6 hours

### Acceptance Criteria
- All metrics calculate correctly from mock data
- Charts render without errors
- Responsive on 1280px+ viewports

---

## Phase 3: Positions Page - Full CRUD

### Pages Affected
- Positions (primary)

### Features to Add

#### 3.1 Detail Drawer
- [ ] Click row to open modal/drawer
- [ ] Show fields:
  - Trade Thesis
  - Entry Date
  - Greeks (Delta, Theta, Vega)
  - Entry Price vs Current Price
  - Profit/Loss Analysis
  - Link to related scenarios
  - Journal notes
  - Action buttons (edit, close, roll, delete)

#### 3.2 Inline Editing
- [ ] Edit premium in place
- [ ] Edit status in place
- [ ] Edit strike in place
- [ ] Save to state (Zustand)
- [ ] Visual feedback (saving spinner, success toast)

#### 3.3 CSV Features
- [ ] CSV Import button opens file picker
- [ ] Parse CSV with Papa Parse
- [ ] Validate columns and data
- [ ] Show error summary if invalid
- [ ] Bulk add positions
- [ ] CSV Export downloads file
- [ ] Create template CSV file
- [ ] Bulk edit with CSV upload

#### 3.4 Search & Advanced Filter
- [ ] Search by symbol or thesis
- [ ] Filter by strategy (wheel, covered call, put)
- [ ] Filter by DTE range
- [ ] Filter by P&L range
- [ ] Multi-select filters
- [ ] Save filters as presets

### Dependencies
- PapaParse for CSV parsing
- Toast/notification library (add to package.json)

### Estimated Effort
⏱️ 8-10 hours

### Acceptance Criteria
- Detail drawer shows all data correctly
- Inline edits persist in Zustand state
- CSV import validates and imports rows
- CSV export creates properly formatted file
- Filters work independently and combined

---

## Phase 4: Scenario Simulator - Core Logic

### Pages Affected
- Scenario Simulator (primary)

### Features to Add

#### 4.1 Greeks Calculations
- [ ] Implement delta calculation
- [ ] Implement theta calculation
- [ ] Implement gamma calculation
- [ ] Implement vega calculation
- [ ] Implement rho calculation
- [ ] Update in real-time as price/time changes

#### 4.2 Price Simulation
- [ ] Slider updates current price
- [ ] Show breakeven points
- [ ] Show support/resistance from watchlist
- [ ] Highlight ITM/OTM zones
- [ ] Show assignment probability

#### 4.3 Time Decay Simulation (DTE)
- [ ] Slider adjusts DTE
- [ ] Recalculate all Greeks with new DTE
- [ ] Show theta decay curve
- [ ] Highlight days to expiration warnings

#### 4.4 Assignment Preference Logic
- [ ] "Prefer Assignment" → optimize for wheels
- [ ] "Avoid Assignment" → optimize for premium
- [ ] "Accept All" → neutral
- [ ] Show explanation based on selection

#### 4.5 Scenario Outcome Calculator
- [ ] Current position outcome at new price/DTE
- [ ] Estimated profit/loss
- [ ] Probability distribution
- [ ] Recommendation (close, roll, assign, hold)

#### 4.6 Roll Simulator
- [ ] Current position details
- [ ] Proposed roll position
- [ ] Credit/debit calculation
- [ ] New Greeks
- [ ] Recommendation (good roll, poor roll, etc.)

#### 4.7 Decision Matrix
- [ ] Condition: Profit > 70% → Action: Consider Closing
- [ ] Condition: DTE < 7 → Action: Review Roll
- [ ] Condition: Price < Support → Action: Assignment Watch
- [ ] Condition: Price > Cost Basis → Action: Prepare Wheel
- [ ] Color code recommendations

#### 4.8 Save Scenario
- [ ] Save current scenario to state
- [ ] Store: position_id, price, dte, outcome, recommendation
- [ ] View saved scenarios in Scenario list
- [ ] Compare scenarios side-by-side

### Dependencies
- Options pricing library (Black-Scholes or similar)
- Statistical distribution library

### Estimated Effort
⏱️ 12-16 hours (if implementing full Greeks, more if using external API)

### Acceptance Criteria
- All Greeks calculate correctly (verify against TOS or similar)
- Scenario outcomes match manual calculations
- Recommendations are logical and consistent
- Save/load scenarios works
- UI updates in real-time as sliders change

### Notes
- May want to use existing options pricing library or API
- Consider using JavaScript port of Black-Scholes
- Alternative: Call Tiger API if available

---

## Phase 5: Calendar - Full Features

### Pages Affected
- Calendar (primary)

### Features to Add

#### 5.1 Multiple Views
- [ ] Month view (grid layout)
- [ ] Week view (hourly slots)
- [ ] Agenda view (list, next 30 days)
- [ ] Switch between views
- [ ] Navigate months/weeks

#### 5.2 Event Management
- [ ] Create new event (date, time, title, type, notes)
- [ ] Edit existing event
- [ ] Delete event
- [ ] Drag & drop to reschedule (desktop)
- [ ] Recurring events (weekly, monthly)

#### 5.3 Event Types
- [ ] Earnings announcements
- [ ] Option expirations
- [ ] Economic events (Fed, jobs report, CPI)
- [ ] Crypto events (halvings, forks)
- [ ] Personal reminders
- [ ] Color-coded by type

#### 5.4 Integration with Positions
- [ ] Auto-create expiration events from positions table
- [ ] Auto-create earnings events from TSLA/IBIT/etc.
- [ ] Link events to positions
- [ ] Show related positions in event detail

#### 5.5 CSV Features
- [ ] Export calendar to CSV
- [ ] Import events from CSV
- [ ] Create event template

#### 5.6 Notifications
- [ ] Alert N days before expiration
- [ ] Alert for earnings announcements
- [ ] Alert for economic events
- [ ] Toast notifications
- [ ] Email alerts (optional Phase 2)

### Dependencies
- React Big Calendar (already in package.json)
- date-fns for date manipulation

### Estimated Effort
⏱️ 6-8 hours

### Acceptance Criteria
- All three views render correctly
- Create/edit/delete works
- Events appear in correct view
- CSV import/export works
- Positions auto-create expiration events

---

## Phase 6: Wheel Tracker - Editable Cycles

### Pages Affected
- Wheel Tracker (primary)
- Dashboard (show active cycles)

### Features to Add

#### 6.1 Cycle Management
- [ ] Create new cycle
- [ ] Edit cycle stages
- [ ] Mark cycle complete
- [ ] Calculate cycle metrics
- [ ] Archive completed cycles

#### 6.2 Stage Progression
- [ ] Stage: Put Sold → visual indicator
- [ ] Stage: Assigned → confirm assignment price
- [ ] Stage: CC Sold → enter CC premium
- [ ] Stage: Called Away → confirm call price
- [ ] Stage: New Put → restart cycle or exit

#### 6.3 Metrics Calculation
- [ ] Total premium = put + CC
- [ ] Cost basis = assignment price - CC credit
- [ ] Return on capital = total premium / cost basis
- [ ] Cycle length = days from put sale to exit
- [ ] Annualized return = (return / cycle length) * 365

#### 6.4 Table Features
- [ ] Inline editing (premium, prices)
- [ ] Color-coded by stage
- [ ] Sort by symbol, total premium, return %
- [ ] Filter by symbol, status
- [ ] CSV export

#### 6.5 Dashboard Integration
- [ ] Show active cycles count
- [ ] Show total premium this month
- [ ] Show best/worst performing cycle
- [ ] Show avg cycle length

### Dependencies
- None new (use existing state/table patterns)

### Estimated Effort
⏱️ 4-6 hours

### Acceptance Criteria
- Create/edit cycles works
- Metrics calculate correctly
- Table displays and sorts correctly
- Dashboard shows cycle summary

---

## Phase 7: Watchlist & Income Trackers

### Pages Affected
- Rotation Watchlist
- Income Tracker
- Dashboard (monthly premium card)

### Features to Add

#### 7.1 Watchlist
- [ ] Inline editing (price, support, resistance, notes)
- [ ] Editable bias (bullish, neutral, bearish)
- [ ] Add new symbols
- [ ] Delete symbols
- [ ] Sort by trend, bias, price change
- [ ] CSV import/export

#### 7.2 Income Tracker - Charts
- [ ] Monthly premium chart (bar chart)
- [ ] Yearly premium trend (line chart)
- [ ] Premium by symbol (pie chart)
- [ ] Premium by strategy (donut chart)
- [ ] YTD vs projections

#### 7.3 Income Tracker - Analysis
- [ ] Monthly average premium
- [ ] Best month/symbol/strategy
- [ ] Rolling 3-month average
- [ ] Projection for year-end
- [ ] CSV export with monthly detail

#### 7.4 Dashboard Updates
- [ ] Monthly premium card shows trend
- [ ] Show best performing symbol
- [ ] Show best performing strategy

### Dependencies
- Recharts (already in package.json)

### Estimated Effort
⏱️ 4-5 hours

### Acceptance Criteria
- All charts render correctly
- Income calculations are accurate
- CSV export includes all columns
- Watchlist edit/delete works

---

## Phase 8: Journal - Full CRUD + Export

### Pages Affected
- Journal (primary)
- Dashboard (recent trades widget)

### Features to Add

#### 8.1 Journal CRUD
- [ ] Create new journal entry (form modal)
- [ ] Edit existing entry
- [ ] Delete entry
- [ ] Inline editing of entries
- [ ] Add tags on the fly

#### 8.2 Journal Filtering
- [ ] Filter by tag (multi-select)
- [ ] Filter by symbol
- [ ] Filter by date range
- [ ] Filter by result (+/-)
- [ ] Search by thesis/lesson text

#### 8.3 Export Features
- [ ] Export to CSV (all columns)
- [ ] Export to JSON (structured data)
- [ ] Export filtered results only
- [ ] Download as file

#### 8.4 Analytics
- [ ] Win rate calculation
- [ ] Most common lessons learned
- [ ] Tag frequency analysis
- [ ] Trade frequency by symbol
- [ ] Trading statistics dashboard

#### 8.5 Dashboard Integration
- [ ] Show last 3 journal entries
- [ ] Show win rate %
- [ ] Show most recent lesson

### Dependencies
- None new

### Estimated Effort
⏱️ 5-7 hours

### Acceptance Criteria
- Create/edit/delete entries works
- Filtering is responsive
- CSV/JSON export works
- Analytics calculations are correct

---

## Phase 9: Data Persistence - IndexedDB

### Pages Affected
- All pages

### Features to Add

#### 9.1 Database Setup (Dexie)
- [ ] Create DB with schema
- [ ] Create tables:
  - positions
  - journal
  - calendar
  - watchlist
  - wheelCycles
  - scenarios
  - income

#### 9.2 Data Sync
- [ ] Sync Zustand state to IndexedDB
- [ ] Load IndexedDB on app startup
- [ ] Handle conflicts (local vs stored)
- [ ] Sync on every CRUD operation

#### 9.3 Data Migrations
- [ ] Handle schema changes
- [ ] Backward compatibility
- [ ] Migration helpers

#### 9.4 Backup & Restore
- [ ] Export all data to JSON
- [ ] Import data from JSON
- [ ] Clear all data (with confirmation)

#### 9.5 Performance
- [ ] Lazy-load large tables
- [ ] Index frequently-queried fields
- [ ] Pagination for large result sets

### Dependencies
- Dexie (already in package.json)

### Estimated Effort
⏱️ 6-8 hours

### Acceptance Criteria
- Data persists across page refresh
- CRUD operations update DB in real-time
- Export/import works correctly
- No data loss on schema updates

---

## Phase 10: CSV Import/Export - Full Features

### Pages Affected
- Positions, Calendar, Watchlist, Income Tracker, Journal

### Features to Add

#### 10.1 CSV Templates
- [ ] Generate template files for each data type
- [ ] Include instructions/examples in template
- [ ] Show column requirements
- [ ] Validate against template

#### 10.2 Bulk Import
- [ ] Drag & drop file upload
- [ ] File picker dialog
- [ ] Preview before import (show first 5 rows)
- [ ] Validate all rows before committing
- [ ] Show error summary if validation fails
- [ ] Partial import option (skip invalid rows)

#### 10.3 Import Validation
- [ ] Check required columns present
- [ ] Check data types (numbers, dates)
- [ ] Check value ranges (strike, premium)
- [ ] Check for duplicates
- [ ] Check referential integrity (symbol exists)

#### 10.4 Bulk Export
- [ ] Export all data or filtered data
- [ ] Choose columns to include
- [ ] Choose date format
- [ ] Choose decimal precision
- [ ] Download as file

#### 10.5 Advanced Features
- [ ] Recurring imports (e.g., sync from broker CSV daily)
- [ ] Import history/audit log
- [ ] Rollback last import
- [ ] Merge duplicates

### Dependencies
- PapaParse (already in package.json)

### Estimated Effort
⏱️ 6-8 hours

### Acceptance Criteria
- Template generation works
- Bulk import validates correctly
- Invalid rows show helpful errors
- Export creates valid CSV
- Can re-import exported data

---

## Phase 11: Tiger API Integration (Optional)

### Pages Affected
- Positions (real data)
- Scenario Simulator (real Greeks)
- Dashboard (real P&L)

### Features to Add

#### 11.1 API Setup
- [ ] Initialize Tiger API client
- [ ] Authentication/API key management
- [ ] Error handling for API calls
- [ ] Rate limiting

#### 11.2 Real Options Data
- [ ] Fetch option chain for symbols
- [ ] Display real strike prices
- [ ] Display real bid/ask spreads
- [ ] Display real Greeks
- [ ] Display real IV

#### 11.3 Live Updates
- [ ] Poll for position updates (every 5 min?)
- [ ] Update Greeks in real-time
- [ ] Update P&L from real broker data
- [ ] Show last update timestamp

#### 11.4 Account Integration
- [ ] Fetch real account snapshot
- [ ] Fetch real positions
- [ ] Fetch real P&L
- [ ] Fetch buying power, cash available

#### 11.5 Broker Actions (Optional)
- [ ] Place trade (with confirmation)
- [ ] Close position
- [ ] Roll position
- [ ] Bracket orders

### Dependencies
- tiger-broker (npm package for Tiger API, if exists)
- Or: Custom HTTP client (axios/fetch)

### Estimated Effort
⏱️ 8-12 hours (depending on API documentation)

### Acceptance Criteria
- Real option chains display
- Greeks match Tiger/TOS data
- Account snapshot updates correctly
- No connection: app gracefully falls back to mock data

---

## Long-Term Features (Beyond Phase 11)

### Mobile Responsiveness
- [ ] Responsive layout for tablet (1024px)
- [ ] Responsive layout for mobile (640px)
- [ ] Touch-friendly navigation
- [ ] Mobile-optimized tables/charts

### Additional Calculators
- [ ] Margin calculator
- [ ] Position sizing calculator
- [ ] Risk/reward calculator
- [ ] Wheel return calculator

### Advanced Analytics
- [ ] Tax reporting
- [ ] Trade statistics dashboard
- [ ] Strategy performance comparison
- [ ] Backtesting tools

### Notifications & Alerts
- [ ] Email alerts for earnings
- [ ] Email alerts for expirations
- [ ] Slack integration
- [ ] Mobile push notifications

### Community Features
- [ ] Share wheel strategy with others
- [ ] Compare with other traders
- [ ] Strategy templates from community
- [ ] Discussion forums

### Dark Mode
- [ ] Toggle dark/light theme
- [ ] Persist preference

---

## Development Priorities

### Quick Wins (1-2 hours each)
1. Dashboard metrics
2. Position inline editing
3. Watchlist editing
4. Journal filtering

### High Impact (4-8 hours each)
1. Scenario Simulator logic
2. CSV import/export
3. Calendar full features
4. IndexedDB persistence

### Nice to Have (but lengthy, 8+ hours)
1. Tiger API integration
2. Mobile responsiveness
3. Advanced analytics
4. Community features

---

## Testing Strategy

### Unit Tests
- Greek calculations accuracy
- Date range calculations
- Metric aggregations
- CSV parsing

### Integration Tests
- Page navigation
- State persistence
- IndexedDB operations
- CSV import/export flow

### E2E Tests
- Complete wheel cycle (put → assign → CC → close)
- Add position → view in scenarios → save scenario
- Import CSV → verify data → export CSV

### Manual Testing
- Test on Chrome, Firefox, Safari (desktop)
- Test on iPad (tablet)
- Test with mock vs real data
- Test with empty states
- Test error cases

---

## Timeline Estimate

| Phase | Duration | Cumulative |
|-------|----------|-----------|
| 1 | 6 hours | 6h |
| 2 | 5 hours | 11h |
| 3 | 9 hours | 20h |
| 4 | 14 hours | 34h |
| 5 | 7 hours | 41h |
| 6 | 5 hours | 46h |
| 7 | 5 hours | 51h |
| 8 | 6 hours | 57h |
| 9 | 7 hours | 64h |
| 10 | 7 hours | 71h |
| 11 | 10 hours | 81h |

**Core Application (Phases 1-10): ~71 hours (~2 weeks full-time, ~2 months part-time)**

**With API Integration (Phase 11): ~81 hours (~2.5 weeks full-time)**

---

## Success Criteria

When Phase 1 is complete:
✅ All 8 pages load and navigate correctly
✅ Sidebar persists across all pages
✅ Mock data displays in tables
✅ Design matches reference images
✅ No console errors

When all 11 phases complete:
✅ Fully functional trading decision-support platform
✅ Persistent data across sessions
✅ Real options Greeks and pricing
✅ CSV import/export for all data types
✅ Live position tracking from broker
✅ Comprehensive journal and analytics
✅ Mobile-responsive UI

---

## Git Workflow

Suggested commit messages by phase:
```
feat(phase1): Initialize app shell with routing and sidebar
feat(phase2): Add dashboard metrics and charts
feat(phase3): Implement positions CRUD and CSV features
feat(phase4): Add scenario simulator with Greeks calculations
...
```

---

## Questions & Notes

### For Richard
1. **Tiger API**: Do you have access? API key ready?
2. **Mobile**: Critical for tablet (iPad) at least, or desktop-only for now?
3. **Priorities**: Which phase is most valuable to build next?
4. **Data**: Any existing CSV files to import for testing?
5. **Styles**: Any adjustments to the design system before Phase 2?

---

**Last Updated:** June 2025
**Status:** Phase 1 Complete ✅
**Next Phase:** Awaiting approval to start Phase 2

