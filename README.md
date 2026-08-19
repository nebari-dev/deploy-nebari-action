# Deploy Nebari

[![CI](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/ci.yml/badge.svg)](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/ci.yml)
[![Lint Codebase](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/linter.yml/badge.svg)](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/linter.yml)
[![Check dist/](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/nebari-dev/deploy-nebari-action/actions/workflows/codeql-analysis.yml)
![Coverage](./badges/coverage.svg)

This action deploys a Nebari platform from a config file using the [`nic` CLI](https://github.com/nebari-dev/nebari-infrastructure-core), and destroys it automatically when the job ends, even on failure or cancellation.

Specifically, the action:

- Acquires `nic` from a prebuilt binary (`nic-binary`) or from a release or Git ref (`nic-version`), verifying release downloads against their checksums and build provenance attestations (release tags must be v0.10.0 or newer because earlier releases have no attestation and are thus refused).
- Runs `nic deploy` with your config (or a built-in local kind default).
- Exports `KUBECONFIG` so every later step in the job runs against the deployed cluster.
- Waits for the deployment to converge: nebari-root Synced, every Argo CD Application Healthy, and that state stable across consecutive polls.
- Exposes the platform's entry points as outputs: the Keycloak and ArgoCD admin credentials (masked in logs), the gateway address, and the domain and Keycloak issuer URL. Each output degrades to an empty string when its source is missing, so non-default configs still deploy fine.
- Destroys the deployment in a post step when the job ends, even when the job failed or was cancelled.

## Quickstart

Deploy the built-in default config (a local kind cluster with an auto-created local gitops repository) using the latest `nic` release:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: nebari-dev/deploy-nebari-action@main
        with:
          nic-version: latest

      # KUBECONFIG is exported so kubectl commands run against the deployed cluster.
      - run: kubectl get pods -A
```

<!-- action-docs-inputs source="action.yml" -->

## Inputs

| name              | description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | required | default               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `config`          | <p>Path to the NIC config file, relative to the workspace. When unset, the action deploys its built-in default: a local kind cluster with an auto-created local gitops repository (see default-config.yaml in the action repository). Copy it into your repository as a starting point for a custom config.</p>                                                                                                                                                                                                                              | `false`  | `""`                  |
| `nic-binary`      | <p>Path to a local prebuilt nic binary. Set exactly one of nic-binary and nic-version.</p>                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `false`  | `""`                  |
| `nic-version`     | <p>NIC version to acquire. Mutually exclusive with nic-binary.</p> <ul> <li>'latest': download the latest release binary (checksum- and provenance-verified).</li> <li>'vX.Y.Z': download that release binary (checksum- and provenance-verified). Must be v0.10.0 or newer; earlier releases have no provenance attestation and are refused.</li> <li>any other string: fetch that Git ref (branch, tag, or commit SHA) of nebari-dev/nebari-infrastructure-core and build from source (requires Go, e.g. via actions/setup-go).</li> </ul> | `false`  | `""`                  |
| `wait`            | <p>Wait for the deployment to converge after deploy (nebari-root Synced, all Argo CD Applications Healthy, stable across consecutive polls).</p>                                                                                                                                                                                                                                                                                                                                                                                             | `false`  | `true`                |
| `wait-timeout`    | <p>Seconds to wait for Applications to converge.</p>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `false`  | `1200`                |
| `restart-budgets` | <p>Comma-separated namespace=count pairs overriding the per-namespace container restart budgets the wait uses to fail fast on crashloops (e.g. 'keycloak=12,cnpg-system=8'). Use <code>*=count</code> to override the budget for namespaces without a specific override. Only used when wait is true.</p>                                                                                                                                                                                                                                    | `false`  | `""`                  |
| `destroy`         | <p>Destroy the deployment in the post step when the job ends.</p>                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `false`  | `true`                |
| `force`           | <p>Pass --force to nic destroy so teardown continues past individual resource failures.</p>                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `false`  | `true`                |
| `token`           | <p>GitHub token used to resolve and download NIC releases (nic-version mode).</p>                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `false`  | `${{ github.token }}` |

<!-- action-docs-inputs source="action.yml" -->

<!-- action-docs-outputs source="action.yml" -->

## Outputs

| name                            | description                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubeconfig`                    | <p>Path to a kubeconfig for the deployed cluster (also exported as KUBECONFIG).</p>                                                                                                                                                                                                                                                                                                                                           |
| `nic-binary`                    | <p>Path to the nic binary used, for running further nic commands in later steps.</p>                                                                                                                                                                                                                                                                                                                                          |
| `domain`                        | <p>The domain the platform was actually deployed with (e.g. nebari.local), read from the deployed keycloak HTTPRoute so NIC's domain defaulting is reflected, with the config file as a fallback. Handy for building the hostnames consumers route to (keycloak.<domain>, etc.). Empty if neither source is readable.</p>                                                                                                     |
| `keycloak-issuer-url`           | <p>External public issuer URL for the Keycloak deployment, e.g. https://keycloak.nebari.local, read from the deployed keycloak HTTPRoute (the hostname NIC rendered), with the config file as a fallback. Useful for JWT <code>iss</code> claim validation in e2e tests. Empty if neither source is readable.</p>                                                                                                             |
| `keycloak-admin-password`       | <p>Keycloak admin password for the <em>master</em> realm, masked in logs. Use keycloak-realm-admin-password for the nebari realm. Empty if the secret could not be read.</p>                                                                                                                                                                                                                                                  |
| `keycloak-realm-admin-password` | <p>Keycloak admin password for the <em>nebari</em> realm, masked in logs. Provisioned asynchronously by NIC's realm-setup PostSync hook after Keycloak becomes Ready, so this can be empty if the secret has not materialized by the time the action polls for it; consumers can then read the <code>nebari-realm-admin-credentials</code> secret in the <code>keycloak</code> namespace themselves after their own wait.</p> |
| `argocd-admin-password`         | <p>ArgoCD initial admin password, masked in logs. Empty if the secret could not be read (e.g. already deleted after a password change).</p>                                                                                                                                                                                                                                                                                   |
| `gateway-ip`                    | <p>Address of the LoadBalancer service owned by NIC's nebari-gateway Gateway: the IP (MetalLB on the default local kind cluster) or, on cloud LBs that only get one, the hostname. Empty if no LoadBalancer address was assigned within the extraction window.</p>                                                                                                                                                            |

<!-- action-docs-outputs source="action.yml" -->

## Usage

### Custom config

Copy [`default-config.yaml`](default-config.yaml) into your repository as a starting point, edit it, and pass it via the `config` input.

Note that `nic` requires the config to declare exactly one `repository:` provider. The default config uses the `local` provider, which auto-creates a gitops repository on the runner. To have `nic` push to a remote repository instead, use the `existing` provider and supply credentials through an environment variable. See the [NIC configuration examples](https://github.com/nebari-dev/nebari-infrastructure-core/tree/main/examples).

```yaml
repository:
  existing:
    url: 'git@github.com:my-org/my-gitops-repo.git'
    branch: main
    path: 'clusters/my-nebari'
    auth:
      ssh:
        env: GIT_SSH_PRIVATE_KEY
      # or, for HTTPS:
      # token:
      #   env: GIT_TOKEN
```

```yaml
- uses: nebari-dev/deploy-nebari-action@main
  with:
    config: ci/nebari-config.yaml
    nic-version: latest
    wait-timeout: '1800'
```

### Prebuilt binary

When a previous job already built `nic` (for example from the PR under test), pass the binary directly instead of a version:

```yaml
- uses: actions/download-artifact@v6
  with:
    name: nic

- run: chmod +x nic

- uses: nebari-dev/deploy-nebari-action@main
  with:
    config: ci/nebari-config.yaml
    nic-binary: nic
```

### Source build from a Git ref

Any `nic-version` that is not `latest` or a release tag is treated as a Git ref of nebari-infrastructure-core and built from source, which requires Go:

```yaml
- uses: actions/setup-go@v6
  with:
    go-version-file: go.mod

- uses: nebari-dev/deploy-nebari-action@main
  with:
    nic-version: main
```

### Using the platform outputs

The action exposes the deployed platform's entry points as step outputs, useful for e2e tests that talk to Keycloak or route through the gateway:

```yaml
- uses: nebari-dev/deploy-nebari-action@main
  id: nebari
  with:
    nic-version: latest

- name: Log in to Keycloak
  run: |
    kubectl get secret -n envoy-gateway-system nebari-gateway-tls \
      -o jsonpath='{.data.ca\.crt}' | base64 -d > ca.crt
    curl --cacert ca.crt \
      --resolve "keycloak.${{ steps.nebari.outputs.domain }}:443:${{ steps.nebari.outputs.gateway-ip }}" \
      "${{ steps.nebari.outputs.keycloak-issuer-url }}/.well-known/openid-configuration"
```

The credential outputs are registered as secrets, so they are masked in job logs. The default gateway certificate is selfsigned, so clients that verify TLS need its CA: extract it from the `nebari-gateway-tls` secret as shown above, and build a ConfigMap or Secret mount from it for pods that need to trust `https://<domain>` in-cluster.

### Keeping the deployment

Set `destroy: false` to leave the deployment running when the job ends, for example to debug a failing environment:

```yaml
- uses: nebari-dev/deploy-nebari-action@main
  with:
    nic-version: latest
    destroy: false
```

Cloud deployments left running must be destroyed manually with `nic destroy`.
