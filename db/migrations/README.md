# Completed migration records

The one-time public-to-lean conversion scripts and dated status files are
retained as an audit record of the completed live rollout and its validation.
The numbered conversion scripts are not part of normal deployment.

The current fresh-install baseline is [`db/init-lean/`](../init-lean/).
Subsequent schema changes must use a new forward migration or a verified
restore.
