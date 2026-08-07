<script lang="ts">
import { HttpError } from "@neta-art/cohub";
import { onMount } from "svelte";
import {
	completeSignInCallback,
	markAuthJustCompleted,
	sanitizeRedirectPath,
} from "$lib/auth";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import { sdk } from "$lib/sdk";

let error = $state("");

onMount(async () => {
	try {
		const stateParams = new URLSearchParams(
			new URLSearchParams(window.location.search).get("state") ?? "",
		);
		const redirectPath = sanitizeRedirectPath(
			stateParams.get("redirect_path") ?? "/",
		);

		// Exchange the authorization code from the URL for tokens.
		// Callback exchange and token publication share the refresh/recovery lock.
		const token = await completeSignInCallback(window.location.href);
		if (!token) {
			error =
				"Signed in, but no API access token was issued. Check Logto API resource configuration, then try again.";
			return;
		}

		// Ensure the resource access token is accepted by the API before leaving
		// the callback. A wrong audience/claim can still yield a token string.
		try {
			await sdk.user.getMe({ skipUnauthorizedHandler: true });
		} catch (err) {
			if (err instanceof HttpError && err.status === 401) {
				error =
					"Signed in, but the API rejected the access token. Check Logto API resource and claim configuration, then try again.";
				return;
			}
			// Transient network errors should not block an otherwise valid login.
			console.warn("[callback] Profile probe failed; continuing:", err);
		}

		markAuthJustCompleted();

		const redirectUri = new URL(redirectPath, window.location.origin);
		if (redirectUri.origin !== window.location.origin) {
			window.location.replace("/");
			return;
		}
		window.location.replace(redirectUri.toString());
	} catch (err) {
		error = err instanceof Error ? err.message : "Authentication failed";
	}
});
</script>

<svelte:head>
	<title>Authenticating — Cohub</title>
</svelte:head>

<div class="flex-1 flex items-center justify-center min-h-100dvh">
  {#if error}
    <div class="text-center max-w-sm px-4">
      <p class="text-sm text-error-soft">{error}</p>
      <a href="/" class="mt-4 inline-block text-xs text-text-tertiary hover:text-text-secondary underline">Back to home</a>
    </div>
  {:else}
    <CenteredLoading label="Authenticating…" size="page" />
  {/if}
</div>
