/** @jsxImportSource hono/jsx */

/**
 * The list, frame and empty note are filled by the page client from
 * `GET /api/reports`; titles are written as text, never markup.
 */
export function Reports() {
  return (
    <section className="panel reports-panel" data-reports-view>
      <div className="section-header">
        <div>
          <h3>Hosted reports</h3>
          <p className="section-note">Reports published by agent sessions Studio started.</p>
        </div>
      </div>
      <div className="reports-layout">
        <div className="reports-side">
          <ul id="reports-list" className="reports-list" aria-label="Reports" />
          <template id="reports-item-template">
            <li>
              <button type="button" data-report-id="">
                <span data-report-title />
                <span className="report-time" data-report-time />
              </button>
            </li>
          </template>
          <p id="reports-empty" className="empty">
            No hosted reports yet.
          </p>
        </div>
        <div className="reports-main">
          <div className="reports-bar">
            <a id="reports-open" target="_blank" rel="noopener noreferrer" hidden>
              Open in new tab
            </a>
          </div>
          <iframe
            id="reports-frame"
            className="reports-frame"
            title="Hosted report"
            sandbox="allow-scripts allow-modals"
            referrerPolicy="no-referrer"
            hidden
          />
        </div>
      </div>
    </section>
  );
}
