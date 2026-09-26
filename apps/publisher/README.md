# Publisher

Post one update to every social account of up to four apps with one command. It uses the direct platform adapters in `@opencoredev/social-sdk`, so there is no scheduling service and no monthly fee. Each account signs in with the platform's own API.

```sh
bun run social post --brand all --text "v2.0 is out: https://app-one.example.com/changelog" --dry-run
```

## How it works

- `brands.json` lists your apps ("brands") and each app's accounts. Every account gets its own SDK backend, named after its id, so two X accounts never share a token.
- `bun run social connect <account-id>` signs an account in once. Its tokens go to `.data/credentials.json`, which is git-ignored and readable only by your user.
- `bun run social post` loads the selected accounts and refreshes any token that is about to expire. It then checks the post against each platform's rules, skips the accounts that cannot take it (with the reason), asks before sending, and posts to the rest. Each account gets its own result: one failure does not stop the others.
- `--dry-run` runs every check with no network access to any social platform.

## Set up

From the repository root:

```sh
bun install
cd apps/publisher
cp .env.example .env                 # then add your developer app keys
# brands.json already lists StoneSight AI, Discount Hunter AI, Mr & Mrs Peptides and Lintel AI.
# brands.example.json shows every option.
```

### brands.json

```json
{
  "brands": [
    {
      "id": "app-one",
      "name": "App One",
      "accounts": [
        { "id": "app-one-x", "platform": "x" },
        { "id": "app-one-bluesky", "platform": "bluesky" },
        { "id": "app-one-linkedin", "platform": "linkedin", "organization": true },
        { "id": "app-one-youtube", "platform": "youtube", "visibility": "public" },
        {
          "id": "app-one-tiktok",
          "platform": "tiktok",
          "privacy": "SELF_ONLY",
          "verifiedMediaOrigins": ["https://app-one.example.com"]
        }
      ]
    }
  ]
}
```

- Ids use lowercase letters, digits and dashes, and every account id is unique.
- Platforms: `x`, `bluesky`, `linkedin`, `threads`, `instagram`, `facebook`, `tiktok`, `youtube`.
- `website` on a brand (optional, https) is that app's site. TikTok accounts use it as their verified media origin unless you set `verifiedMediaOrigins`.
- `linkedin.organization`: `true` posts as a company page, `false` (default) as your personal profile.
- `youtube.visibility`: `public` (default), `unlisted` or `private`. `madeForKids` defaults to `false`.
- `tiktok.privacy` defaults to `SELF_ONLY`. `verifiedMediaOrigins` lists the sites you host TikTok media on.

The file holds no secrets, so you can commit it.

### Developer apps (one per platform)

Each platform needs one developer app, and that app signs in all of your accounts on that platform. Put its keys in `.env`. For each account, add yourself (and any other account you own) as a tester or developer where the platform supports it. You can then post to your own accounts without passing app review.

| Platform  | What to create                                                                                                                                                                           | Cost and limits to know                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bluesky   | Nothing. Create an app password under Settings → Privacy and security → App passwords.                                                                                                   | Free.                                                                                                                                                                                                                                             |
| X         | An app in the X developer portal with OAuth 2.0 enabled, type "Web App", and the callback URL from `.env`.                                                                               | Not free. Since February 2026 the X API is pay-per-use, at about $0.015 a post or $0.20 for a post with a link. `brands.json` leaves X out for that reason.                                                                                       |
| LinkedIn  | An app with the "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" products, plus the callback URL.                                                                    | Free. Posting as a company page also needs the "Community Management API" product, which LinkedIn reviews. Tokens last about 60 days, then run `connect` again.                                                                                   |
| Threads   | A Meta app with the Threads use case. Add your Threads accounts as testers.                                                                                                              | Free. Media must be at a public https URL.                                                                                                                                                                                                        |
| Instagram | A Meta app with "Instagram API with Instagram Login". The account must be a Business or Creator account. Add it as a tester.                                                             | Free. Every post needs an image or video at a public https URL.                                                                                                                                                                                   |
| Facebook  | A Meta app with Facebook Login for Business, asking for `pages_show_list`, `pages_read_engagement` and `pages_manage_posts`. Add yourself as an app admin, and be an admin of each Page. | Free. Posts go to Facebook Pages, not personal profiles. One image or one video per post. The Page token does not expire. Page posting is a small adapter in this app, not part of the SDK, and has only been tested against simulated responses. |
| TikTok    | An app with Login Kit and the Content Posting API. Verify the domain your media is hosted on.                                                                                            | Free. Until TikTok audits your app, posts can only be private (`SELF_ONLY`). Media must be at a public https URL.                                                                                                                                 |
| YouTube   | A Google Cloud project with the YouTube Data API v3 and an OAuth client. Set the consent screen to "In production", because testing-mode refresh tokens expire after 7 days.             | Free. The default quota of 10,000 units a day covers about six uploads. Unverified projects may have uploads locked to private.                                                                                                                   |

Platform terms change. Check each platform's current documentation before you rely on a limit above.

### Login redirect

`OAUTH_REDIRECT_URI` in `.env` must match the callback URL registered in each developer app.

- X, LinkedIn, Google and Facebook (while the Meta app is in development mode) accept the default `http://localhost:8787/callback`. The tool listens there during `connect`, so the login finishes on its own. If a platform rejects `localhost`, use `http://127.0.0.1:8787/callback`.
- Meta (Threads, Instagram) and TikTok only accept `https`. Register a page on one of your sites, such as `https://app-one.example.com/oauth/callback`, and set `OAUTH_REDIRECT_URI` to it while you connect those accounts. The page can be anything, even a 404. After approving, copy the full URL from your browser's address bar and paste it into the terminal.

## Connect accounts

```sh
bun run social connect app-one-bluesky                  # asks for handle and app password
bun run social connect app-one-x                        # opens a login link
bun run social connect app-one-linkedin                 # organization: true picks your company page
bun run social connect app-one-linkedin --pick urn:li:organization:123   # when you admin several pages
bun run social connect stonesight-facebook              # log in, then pick the Page
bun run social connect stonesight-facebook --user-token <token> --pick "StoneSight AI"   # token from the Graph API Explorer
bun run social accounts                                 # who is connected, and when tokens expire
bun run social accounts --verify                        # also asks each platform who the token belongs to
```

Sign in as the account you are connecting. For several X accounts, log out of x.com between them or use a private window.

A token made in a platform's dashboard also works, for example Meta's user token generator:

```sh
bun run social connect app-two-threads --access-token <token> --account-id <threads-user-id> --expires-in-days 60
```

## Post

```sh
# Text to every account of every app
bun run social post --brand all --text "We just shipped dark mode"

# One app, with an image, and a shorter version for X
bun run social post --brand app-one --text "Long announcement..." --x-text "Short version" --image ./launch.png

# A video to YouTube and TikTok only (TikTok needs a public URL)
bun run social post --brand app-one --only youtube,tiktok --title "Dark mode demo" \
  --text "Dark mode in 30 seconds" --video https://app-one.example.com/media/demo.mp4

# See what would happen without sending anything
bun run social post --brand app-two,app-three --text "Hello" --dry-run
```

| Option                            | Meaning                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--brand <id>`                    | Brand id, repeatable or comma-separated, or `all`.                                                                                                                                  |
| `--text <text>`                   | The post text.                                                                                                                                                                      |
| `--<platform>-text <text>`        | Replace the text on one platform: `--x-text`, `--bluesky-text`, `--linkedin-text`, `--threads-text`, `--instagram-text`, `--tiktok-text`, `--youtube-text` (the video description). |
| `--image <path or url>`           | Attach an image. Repeatable.                                                                                                                                                        |
| `--video <path or url>`           | Attach a video.                                                                                                                                                                     |
| `--title <title>`                 | YouTube and TikTok title. Defaults to the first line of the text.                                                                                                                   |
| `--only <platform or account id>` | Limit the post. Repeatable or comma-separated.                                                                                                                                      |
| `--dry-run`                       | Check everything without contacting any social platform.                                                                                                                            |
| `--yes`                           | Skip the confirmation prompt, for scripts.                                                                                                                                          |

Media rules the tool handles for you:

- **Local files vs URLs.** X, Bluesky, LinkedIn, Facebook and YouTube take uploaded files. Threads, Instagram and TikTok fetch media from a public `https://` URL. Pass a URL and the tool downloads it for the upload platforms. Pass a local file and the URL-only platforms are skipped, with a message saying why.
- **LinkedIn.** Media is uploaded first, then posted. A LinkedIn video can take a while to process, so the tool retries for about two minutes.
- **Bluesky.** The SDK does not support Bluesky video uploads yet. Images work.
- **YouTube** needs exactly one video.
- **Facebook** takes one image or one video per post. A video shows as `processing` because Facebook publishes it after processing.
- **Text-only posts** reach Facebook and LinkedIn only. Instagram, TikTok and YouTube always need an image or video.

Each run appends its results to `.data/history.jsonl`: post ids, links, and anything skipped or failed.

## Check your changes

```sh
bun run check-types
bun run test
```

Tests run offline against simulated platform responses. They never post.
