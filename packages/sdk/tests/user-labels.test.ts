import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpClient } from "../src/http.js";

function createClient(onRequest: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return createHttpClient({
    baseUrl: "https://api.example.test",
    fetch: async (url, init) => onRequest(String(url), init),
  });
}

test("user labels list and space-groups hit /api/me", async () => {
  const urls: string[] = [];
  const client = createClient(async (url) => {
    urls.push(url);
    if (url.endsWith("/api/me/space-groups")) {
      return new Response(JSON.stringify({ groups: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ labels: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await client.user.labels.list();
  await client.user.labels.listSpaceGroups();
  assert.deepEqual(urls, [
    "https://api.example.test/api/me/labels",
    "https://api.example.test/api/me/space-groups",
  ]);
});

test("user labels create and remove use name", async () => {
  let createBody: string | undefined;
  let deleteUrl = "";
  const client = createClient(async (url, init) => {
    if (init?.method === "POST") {
      createBody = typeof init.body === "string" ? init.body : undefined;
      return new Response(JSON.stringify({ label: { id: "1", name: "Work" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    deleteUrl = url;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await client.user.labels.create("Work");
  await client.user.labels.remove("Work");
  assert.equal(createBody, JSON.stringify({ name: "Work" }));
  assert.equal(deleteUrl, "https://api.example.test/api/me/labels?name=Work");
});

test("user labels patch still assigns a space", async () => {
  let request: { url: string; method?: string; body?: string } | null = null;
  const client = createClient(async (url, init) => {
    request = {
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    return new Response(JSON.stringify({ assignments: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await client.user.labels.patchResourceLabels("space", "space-1", {
    addLabelRefs: ["Work"],
  });
  assert.equal(request?.url, "https://api.example.test/api/me/resources/space/labels?resourceRef=space-1");
  assert.equal(request?.method, "PATCH");
  assert.equal(request?.body, JSON.stringify({ addLabelRefs: ["Work"] }));
});
