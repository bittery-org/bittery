## Default Permission

Allows the four bittery-keystore commands. All four are needed by
`packages/storage`'s tauri-mobile adapter: without `secret_available` the adapter
cannot probe, and without the other three the `secret` tier has no backing.

#### This default permission set includes the following:

- `allow-secret-set`
- `allow-secret-get`
- `allow-secret-delete`
- `allow-secret-available`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`bittery-keystore:allow-secret-available`

</td>
<td>

Enables the secret_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-keystore:deny-secret-available`

</td>
<td>

Denies the secret_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-keystore:allow-secret-delete`

</td>
<td>

Enables the secret_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-keystore:deny-secret-delete`

</td>
<td>

Denies the secret_delete command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-keystore:allow-secret-get`

</td>
<td>

Enables the secret_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-keystore:deny-secret-get`

</td>
<td>

Denies the secret_get command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-keystore:allow-secret-set`

</td>
<td>

Enables the secret_set command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-keystore:deny-secret-set`

</td>
<td>

Denies the secret_set command without any pre-configured scope.

</td>
</tr>
</table>
