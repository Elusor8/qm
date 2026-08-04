# Use the API origin for deployment git URLs

When QM has separate web and API origins, `GET /v1/deployments/:id/git-url`
returns a clone URL on the web origin. The git smart-HTTP service is on the API
origin, so cloning the returned URL as-is fails with “repository not found.”

Could deployment git URLs use the configured API origin instead? This also
applies to the `gitUrl` fields returned by deployment list and detail. The test
should clone the returned URL without rewriting its host.
