## Default Permission

Allows the credential provider support probe. Nothing sensitive sits behind it:
it reports the device API level, whether the user has enabled Bittery as a
provider, and whether the service reached the merged manifest.

#### This default permission set includes the following:

- `allow-is-supported`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`bittery-credential-provider:allow-is-supported`

</td>
<td>

Enables the is_supported command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-is-supported`

</td>
<td>

Denies the is_supported command without any pre-configured scope.

</td>
</tr>
</table>
