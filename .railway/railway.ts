import { defineRailway, project, service, volume } from "railway/iac";

// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "hub";

export default defineRailway(() => {
  // The hub's SQLite database and its daily backups live here (DATA_DIR=/data).
  const data = volume("hub-volume", { region: "sfo", sizeMB: 5000 });

  const hub = service("hub", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["hub.js", "server/**", "public/**", "bin/**", "*.js", "package.json", "Dockerfile", "docker-entrypoint.sh"],
    },
    healthcheck: "/readyz",
    healthcheckTimeout: 60,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      drainingSeconds: 15,
    },
    volumeMounts: { "/data": data },
  });

  return project("backchannel", {
    resources: [hub, data],
  });
});
