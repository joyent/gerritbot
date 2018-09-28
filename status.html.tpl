html(lang="en")
  head
    title Gerrit bot status
    style(type="text/css").
      body { font-family: Sans-serif; }
      table { text-align: left; padding: 1px; }
      tr:nth-child(even) { background: #eee; }
      th { padding: 0.25em; }
      td { padding: 0.5em; }
      form { padding: 0; margin: 0; }
      .section { float: left; margin: 2em; }
  body
    h2 Gerrit bot status
    .section
      h3 Queue
      table
        tr
          th Repo
          th Change num
          th Patch set
        each a in queue
          tr
            td= a[0].project
            td= a[0].number
            td= a[1].number
    .section
      h3 Overrides
      table
        tr
          th Repo
          th Status
          th
        each repo in Object.keys(overrides)
          tr
            td= repo
            if overrides[repo] === true
              td Always build
            else
              td(style="color: #500") Never build
            td
              form(action="/override", method="post")
                input(type="hidden", name="repo", value=repo)
                input(type="hidden", name="clear", value="true")
                button(type="submit") Clear
        tr
          form(action="/override", method="post")
            td
              input(type="text", name="repo", placeholder="e.g. joyent/foobar")
            td
              select(name="value")
                option(value="true") Always build
                option(value="false") Never build
            td
              button(type="submit") Add

      form(action="/bootstrap", method="post")
        button(type="submit") Re-query all changes
    .section
      h3 Workers
      table
        tr
          th UUID
          th State
          th Assignment
        each uuid in Object.keys(spawning)
          tr
            td= uuid
            td= spawning[uuid]
            td none
        each slave in slaves
          tr
            td= slave.sc_uuid
            td= slave.getState()
            if slave.sc_change !== undefined
              td #{slave.sc_change.project}: #{slave.sc_change.number}/#{slave.sc_patchset.number}
            else
              td none
    .section
      h3 Enqueue from manual query
      form(action="/runquery", method="post")
        input(type="text", name="query", placeholder="e.g. 5898")
        button(type="submit") Run query
