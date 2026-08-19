import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'

import * as core from '@actions/core'

// The Gateway NIC deploys (pkg/argocd/templates/manifests/networking/
// gateway.yaml). Envoy Gateway labels the LoadBalancer service it generates
// with the owning Gateway's name, so the service is looked up by that
// identity across all namespaces instead of assuming where NIC currently
// places it. TODO(nebari-infrastructure-core#606): replace the whole
// extraction with `nic outputs` once NIC exposes it.
const GATEWAY_NAME = 'nebari-gateway'
const GATEWAY_SVC_SELECTOR = `gateway.envoyproxy.io/owning-gateway-name=${GATEWAY_NAME}`

function sleep(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

// Run kubectl and return trimmed stdout, or '' on any failure: output
// extraction must never be the thing that fails an otherwise successful
// deploy.
function kubectl(args: string[], env: NodeJS.ProcessEnv): string {
  const res = spawnSync('kubectl', args, { encoding: 'utf8', env })
  if (res.error || res.status !== 0 || !res.stdout) return ''
  return res.stdout.toString().trim()
}

// Read one key of a Secret, base64-decoded. '' when the Secret or key is
// missing.
function readSecretKey(
  namespace: string,
  name: string,
  key: string,
  env: NodeJS.ProcessEnv
): string {
  const jsonpath = `{.data.${key.replaceAll('.', '\\.')}}`
  const b64 = kubectl(
    ['-n', namespace, 'get', 'secret', name, '-o', `jsonpath=${jsonpath}`],
    env
  )
  if (!b64) return ''
  return Buffer.from(b64, 'base64').toString('utf8')
}

// Retry fn until it returns a non-empty value or the attempts run out.
function poll(
  what: string,
  attempts: number,
  intervalSeconds: number,
  fn: () => string
): string {
  for (let i = 1; ; i++) {
    const value = fn()
    if (value || i >= attempts) return value
    core.info(`Waiting for ${what}... (attempt ${i}/${attempts})`)
    sleep(intervalSeconds)
  }
}

// The external Keycloak hostname as NIC deployed it, read from the keycloak
// HTTPRoute (NIC renders hostnames: ["keycloak.<domain>"] into it, with its
// domain defaulting already applied). The route is foundational, so on a
// converged platform it always exists; the short poll covers wait=false runs
// where ArgoCD may still be reconciling.
function keycloakIssuerHost(env: NodeJS.ProcessEnv): string {
  return poll('HTTPRoute keycloak/keycloak', 6, 5, () =>
    kubectl(
      [
        '-n',
        'keycloak',
        'get',
        'httproutes.gateway.networking.k8s.io',
        'keycloak',
        '-o',
        'jsonpath={.spec.hostnames[0]}'
      ],
      env
    )
  )
}

/**
 * Parse the top-level `domain` field out of a NIC config file. '' when the
 * file is unreadable or has no domain. A regex instead of a YAML parser: the
 * field is a top-level scalar, and this must tolerate any config NIC itself
 * accepts without dragging in a parser dependency. Fallback only: the
 * deployed HTTPRoute is the primary source, since a config without a domain
 * still gets one from NIC's internal defaulting.
 */
export function parseDomain(configPath: string): string {
  let text: string
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch {
    return ''
  }
  const match = text.match(/^domain:\s*["']?([^"'\s#]+)/m)
  return match ? match[1] : ''
}

// The gateway LoadBalancer address, found by the Gateway that owns the
// service. Prefers .ip (MetalLB on kind, klipper on k3d) and falls back to
// .hostname (cloud LBs like AWS ELB).
function gatewayAddress(env: NodeJS.ProcessEnv): string {
  const query = (field: string) =>
    kubectl(
      [
        'get',
        'svc',
        '-A',
        '-l',
        GATEWAY_SVC_SELECTOR,
        '-o',
        `jsonpath={.items[?(@.spec.type=="LoadBalancer")].status.loadBalancer.ingress[0].${field}}`
      ],
      env
    )
  return query('ip') || query('hostname')
}

/**
 * Extract the platform outputs beyond kubeconfig/nic-binary: admin
 * credentials, the gateway address, and the domain-derived URLs.
 * Best-effort by design — each output degrades to '' with a log line when
 * its source is missing (a component still starting, a non-default platform
 * layout), and nothing here ever fails the action.
 */
export function extractPlatformOutputs(
  kubeconfig: string,
  configPath: string
): void {
  const env = { ...process.env, KUBECONFIG: kubeconfig }
  core.startGroup('Extract platform outputs')
  try {
    // Domain and issuer URL. The issuer host read from the cluster IS the
    // value NIC rendered (https://keycloak.<domain> per pkg/argocd/writer.go),
    // useful for JWT `iss` validation in e2e tests; the domain is that host
    // minus the keycloak. prefix. The config file is only a fallback for
    // when the route is not readable.
    const issuerHost = keycloakIssuerHost(env)
    let domain: string
    let issuerUrl: string
    if (issuerHost) {
      domain = issuerHost.replace(/^keycloak\./, '')
      issuerUrl = `https://${issuerHost}`
    } else {
      core.info(
        'keycloak HTTPRoute not readable; falling back to the config file ' +
          '(note: a config without a domain still gets one from NIC, which ' +
          'this fallback cannot see)'
      )
      domain = parseDomain(configPath)
      issuerUrl = domain ? `https://keycloak.${domain}` : ''
    }
    core.setOutput('domain', domain)
    core.setOutput('keycloak-issuer-url', issuerUrl)
    core.info(`domain: ${domain || '(not found)'}`)
    core.info(`keycloak-issuer-url: ${issuerUrl || '(no domain)'}`)

    // Mask each credential before it goes anywhere near an output. The
    // values themselves are never logged, only whether they were found.
    const setSecretOutput = (name: string, value: string): void => {
      if (value) core.setSecret(value)
      core.setOutput(name, value)
      core.info(`${name}: ${value ? '(found, masked)' : '(not found)'}`)
    }

    setSecretOutput(
      'keycloak-admin-password',
      readSecretKey(
        'keycloak',
        'keycloak-admin-credentials',
        'admin-password',
        env
      )
    )
    // Provisioned asynchronously by NIC's realm-setup PostSync hook after
    // Keycloak becomes Ready, so poll briefly; consumers whose realm setup
    // runs longer can read the secret themselves once it materializes.
    setSecretOutput(
      'keycloak-realm-admin-password',
      poll('secret keycloak/nebari-realm-admin-credentials', 6, 5, () =>
        readSecretKey(
          'keycloak',
          'nebari-realm-admin-credentials',
          'password',
          env
        )
      )
    )
    setSecretOutput(
      'argocd-admin-password',
      readSecretKey('argocd', 'argocd-initial-admin-secret', 'password', env)
    )

    const gatewayIp = poll('gateway LoadBalancer address', 12, 5, () =>
      gatewayAddress(env)
    )
    core.setOutput('gateway-ip', gatewayIp)
    core.info(`gateway-ip: ${gatewayIp || '(not found)'}`)
  } catch (err) {
    core.warning(
      `platform output extraction failed: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    core.endGroup()
  }
}
